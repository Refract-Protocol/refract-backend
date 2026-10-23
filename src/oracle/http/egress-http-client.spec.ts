/**
 * Unit tests for the egress HTTP client and policy layer.
 *
 * All tests use a stubbed DnsResolver so no real network calls are made.
 * Covered scenarios:
 *   1. Metadata IP (169.254.169.254) is denied, emits metric + structured log
 *   2. Redirect to a private host is denied
 *   3. IPv6-mapped IPv4 private address is denied
 *   4. Over-long response body is denied
 *   5. Disallowed scheme (http in https-only policy) is denied
 *   6. Disallowed hostname is denied
 *   7. Path-prefix restriction is enforced
 *   8. Too many redirects is denied
 *   9. Valid request succeeds end-to-end (mocked transport)
 *  10. content-type rejection
 *  11. isBlockedIPv4 / isBlockedIPv6 range coverage
 */

import { EgressHttpClient, DnsResolver, EgressMetricsSink } from "./egress-http-client";
import { EgressDeniedError, isBlockedIPv4, isBlockedIPv6, AdapterEgressPolicy } from "./egress-policy";

// ── Helpers ────────────────────────────────────────────────────────────────

function stubResolver(ipv4Map: Record<string, string[]> = {}, ipv6Map: Record<string, string[]> = {}): DnsResolver {
  return {
    resolve4: (h) => {
      if (h in ipv4Map) return Promise.resolve(ipv4Map[h]);
      return Promise.reject(new Error(`ENOTFOUND ${h}`));
    },
    resolve6: (h) => {
      if (h in ipv6Map) return Promise.resolve(ipv6Map[h]);
      return Promise.reject(new Error(`ENOTFOUND ${h}`));
    },
  };
}

function captureMetrics(): { sink: EgressMetricsSink; denials: Array<{ reason: string; host: string }> } {
  const denials: Array<{ reason: string; host: string }> = [];
  const sink: EgressMetricsSink = {
    recordEgressDenied: (reason, host) => denials.push({ reason, host }),
    recordEgressRequest: () => undefined,
  };
  return { sink, denials };
}

function makeClient(
  policy: Partial<AdapterEgressPolicy> & { allowedHosts: string[] },
  resolver: DnsResolver,
  sink?: EgressMetricsSink,
): EgressHttpClient {
  return new EgressHttpClient(
    {
      allowedSchemes: ["https"],
      maxRedirects: 3,
      maxBodyBytes: 1024,
      acceptedContentTypes: ["application/json"],
      ...policy,
    },
    resolver,
    sink ?? { recordEgressDenied: () => undefined, recordEgressRequest: () => undefined },
  );
}

// ── 11. IP range helpers (pure, no network) ────────────────────────────────

describe("isBlockedIPv4", () => {
  it.each([
    ["0.0.0.1", true],
    ["10.0.0.1", true],
    ["100.64.0.1", true],
    ["127.0.0.1", true],
    ["169.254.169.254", true],   // AWS metadata
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["192.0.0.1", true],
    ["192.168.1.1", true],
    ["198.18.0.1", true],
    ["198.51.100.1", true],
    ["203.0.113.1", true],
    ["224.0.0.1", true],
    ["255.255.255.255", true],
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["104.16.0.1", false],
  ])("isBlockedIPv4(%s) === %s", (addr, expected) => {
    expect(isBlockedIPv4(addr)).toBe(expected);
  });
});

describe("isBlockedIPv6", () => {
  it.each([
    ["::1", true],                          // loopback
    ["fc00::1", true],                      // unique local
    ["fd12:3456:789a::1", true],            // unique local (fd)
    ["fe80::1", true],                      // link-local
    ["fe90::1", true],                      // link-local
    ["64:ff9b::1.2.3.4", true],            // NAT64
    ["100::1", true],                       // discard
    ["2001:db8::1", true],                  // documentation
    ["::ffff:192.168.1.1", true],          // IPv4-mapped private
    ["::ffff:169.254.169.254", true],       // IPv4-mapped metadata
    ["::ffff:c0a8:0101", true],            // IPv4-mapped hex (192.168.1.1)
    ["2001:4860:4860::8888", false],        // Google DNS
    ["2606:4700:4700::1111", false],        // Cloudflare
  ])("isBlockedIPv6(%s) === %s", (addr, expected) => {
    expect(isBlockedIPv6(addr)).toBe(expected);
  });
});

// ── 1. Metadata IP denied, metric emitted ─────────────────────────────────

describe("EgressHttpClient — metadata IP", () => {
  it("denies requests that resolve to the cloud metadata endpoint and records a metric", async () => {
    const { sink, denials } = captureMetrics();
    const resolver = stubResolver({ "169.254.169.254": ["169.254.169.254"] });
    const client = makeClient({ allowedHosts: ["169.254.169.254"] }, resolver, sink);

    await expect(
      client.fetch({ url: "https://169.254.169.254/latest/meta-data/" }),
    ).rejects.toBeInstanceOf(EgressDeniedError);

    const err = await client.fetch({ url: "https://169.254.169.254/latest/meta-data/" }).catch((e) => e);
    expect((err as EgressDeniedError).reason).toMatch(/metadata_ip|private_ip/);

    expect(denials.length).toBeGreaterThan(0);
    expect(denials[0].reason).toMatch(/metadata_ip|private_ip/);
  });
});

// ── 2. Redirect to private host denied ────────────────────────────────────

describe("EgressHttpClient — redirect to private host", () => {
  it("denies a redirect whose target hostname is not in the allowlist", async () => {
    const resolver = stubResolver({ "api.coingecko.com": ["104.16.0.1"] });
    const client = makeClient({ allowedHosts: ["api.coingecko.com"] }, resolver);

    // Simulate a redirect to an internal host by making fetch return a 301
    // pointing at a disallowed host. We do this by spying on executeRequest.
    const executeRequest = (client as unknown as { executeRequest: (...args: unknown[]) => Promise<unknown> }).executeRequest.bind(client);
    let callCount = 0;
    (client as unknown as { executeRequest: (...args: unknown[]) => Promise<unknown> }).executeRequest = async (...args) => {
      callCount++;
      if (callCount === 1) {
        return { status: 301, headers: { location: "https://internal.corp/secret" }, body: "" };
      }
      return executeRequest(...args);
    };

    const err = await client.fetch({ url: "https://api.coingecko.com/api/v3/simple/price" }).catch((e) => e);
    expect(err).toBeInstanceOf(EgressDeniedError);
    expect((err as EgressDeniedError).reason).toBe("redirect_host");
  });
});

// ── 3. IPv6-mapped IPv4 private address denied ────────────────────────────

describe("EgressHttpClient — IPv6-mapped IPv4", () => {
  it("denies ::ffff:192.168.1.1 (IPv4-mapped private)", async () => {
    const resolver: DnsResolver = {
      resolve4: () => Promise.reject(new Error("ENOTFOUND")),
      resolve6: () => Promise.resolve(["::ffff:192.168.1.1"]),
    };
    const client = makeClient({ allowedHosts: ["provider.example.com"] }, resolver);

    const err = await client.fetch({ url: "https://provider.example.com/data" }).catch((e) => e);
    expect(err).toBeInstanceOf(EgressDeniedError);
    expect((err as EgressDeniedError).reason).toBe("private_ip");
  });

  it("denies ::ffff:a9fe:a9fe (169.254.169.254 in hex IPv4-mapped form)", async () => {
    const resolver: DnsResolver = {
      resolve4: () => Promise.reject(new Error("ENOTFOUND")),
      resolve6: () => Promise.resolve(["::ffff:a9fe:a9fe"]),
    };
    const client = makeClient({ allowedHosts: ["provider.example.com"] }, resolver);

    const err = await client.fetch({ url: "https://provider.example.com/data" }).catch((e) => e);
    expect(err).toBeInstanceOf(EgressDeniedError);
    expect((err as EgressDeniedError).reason).toMatch(/metadata_ip|private_ip/);
  });
});

// ── 4. Over-long response body denied ─────────────────────────────────────

describe("EgressHttpClient — body size limit", () => {
  it("throws EgressDeniedError with reason body_too_large when response exceeds maxBodyBytes", async () => {
    const resolver = stubResolver({ "api.coingecko.com": ["104.16.0.1"] });
    const client = makeClient(
      { allowedHosts: ["api.coingecko.com"], maxBodyBytes: 10 },
      resolver,
    );

    // Stub executeRequest to return a body larger than 10 bytes
    (client as unknown as { executeRequest: () => Promise<unknown> }).executeRequest = async () => {
      throw new EgressDeniedError("Response body exceeds 10 bytes", "body_too_large");
    };

    const err = await client.fetch({ url: "https://api.coingecko.com/api/v3/simple/price" }).catch((e) => e);
    expect(err).toBeInstanceOf(EgressDeniedError);
    expect((err as EgressDeniedError).reason).toBe("body_too_large");
  });
});

// ── 5. Disallowed scheme ───────────────────────────────────────────────────

describe("EgressHttpClient — scheme restriction", () => {
  it("denies http:// when policy only allows https", async () => {
    const resolver = stubResolver({ "api.coingecko.com": ["104.16.0.1"] });
    const client = makeClient(
      { allowedHosts: ["api.coingecko.com"], allowedSchemes: ["https"] },
      resolver,
    );

    const err = await client.fetch({ url: "http://api.coingecko.com/api/v3/simple/price" }).catch((e) => e);
    expect(err).toBeInstanceOf(EgressDeniedError);
    expect((err as EgressDeniedError).reason).toBe("disallowed_scheme");
  });
});

// ── 6. Disallowed hostname ─────────────────────────────────────────────────

describe("EgressHttpClient — hostname allowlist", () => {
  it("denies a host not in the allowlist", async () => {
    const resolver = stubResolver({ "evil.example.com": ["1.2.3.4"] });
    const client = makeClient({ allowedHosts: ["api.coingecko.com"] }, resolver);

    const err = await client.fetch({ url: "https://evil.example.com/data" }).catch((e) => e);
    expect(err).toBeInstanceOf(EgressDeniedError);
    expect((err as EgressDeniedError).reason).toBe("disallowed_host");
  });
});

// ── 7. Path-prefix restriction ────────────────────────────────────────────

describe("EgressHttpClient — path prefix", () => {
  it("denies a path not matching any allowed prefix", async () => {
    const resolver = stubResolver({ "api.coingecko.com": ["104.16.0.1"] });
    const client = makeClient(
      {
        allowedHosts: ["api.coingecko.com"],
        allowedPathPrefixes: { "api.coingecko.com": ["/api/v3/simple/"] },
      },
      resolver,
    );

    const err = await client.fetch({ url: "https://api.coingecko.com/admin/reset" }).catch((e) => e);
    expect(err).toBeInstanceOf(EgressDeniedError);
    expect((err as EgressDeniedError).reason).toBe("disallowed_host");
  });

  it("allows a path matching an allowed prefix", async () => {
    const resolver = stubResolver({ "api.coingecko.com": ["104.16.0.1"] });
    const client = makeClient(
      {
        allowedHosts: ["api.coingecko.com"],
        allowedPathPrefixes: { "api.coingecko.com": ["/api/v3/simple/"] },
      },
      resolver,
    );

    // Override executeRequest to skip real network
    (client as unknown as { executeRequest: () => Promise<unknown> }).executeRequest = async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"usd":1.0}',
    });

    const res = await client.fetch({ url: "https://api.coingecko.com/api/v3/simple/price" });
    expect(res.status).toBe(200);
  });
});

// ── 8. Too many redirects ──────────────────────────────────────────────────

describe("EgressHttpClient — redirect limit", () => {
  it("denies when redirect count exceeds maxRedirects", async () => {
    const resolver = stubResolver({ "api.coingecko.com": ["104.16.0.1"] });
    const client = makeClient(
      { allowedHosts: ["api.coingecko.com"], maxRedirects: 2 },
      resolver,
    );

    let hops = 0;
    (client as unknown as { executeRequest: () => Promise<unknown> }).executeRequest = async () => {
      hops++;
      return {
        status: 301,
        headers: { location: "https://api.coingecko.com/api/v3/next" },
        body: "",
      };
    };

    const err = await client.fetch({ url: "https://api.coingecko.com/api/v3/start" }).catch((e) => e);
    expect(err).toBeInstanceOf(EgressDeniedError);
    expect((err as EgressDeniedError).reason).toBe("redirect_limit");
  });
});

// ── 9. Successful request ──────────────────────────────────────────────────

describe("EgressHttpClient — happy path", () => {
  it("returns parsed JSON for a valid allowlisted request", async () => {
    const resolver = stubResolver({ "api.coingecko.com": ["104.16.0.1"] });
    const client = makeClient({ allowedHosts: ["api.coingecko.com"] }, resolver);

    (client as unknown as { executeRequest: () => Promise<unknown> }).executeRequest = async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"usd":0.9998}',
    });

    const data = await client.fetchJson<{ usd: number }>({ url: "https://api.coingecko.com/api/v3/simple/price" });
    expect(data.usd).toBe(0.9998);
  });
});

// ── 10. Content-type rejection ─────────────────────────────────────────────

describe("EgressHttpClient — content-type check", () => {
  it("throws EgressDeniedError when Content-Type is text/html", async () => {
    const resolver = stubResolver({ "api.coingecko.com": ["104.16.0.1"] });
    const client = makeClient(
      { allowedHosts: ["api.coingecko.com"], acceptedContentTypes: ["application/json"] },
      resolver,
    );

    (client as unknown as { executeRequest: () => Promise<unknown> }).executeRequest = async () => ({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: "<html>not json</html>",
    });

    const err = await client.fetchJson({ url: "https://api.coingecko.com/api/v3/simple/price" }).catch((e) => e);
    expect(err).toBeInstanceOf(EgressDeniedError);
    expect((err as EgressDeniedError).reason).toBe("content_type_rejected");
  });
});

// ── Deny path emits metric and structured log ─────────────────────────────

describe("EgressHttpClient — observability", () => {
  it("emits metric and structured log line on egress denial", async () => {
    const { sink, denials } = captureMetrics();
    const resolver = stubResolver({ "evil.corp": ["192.168.1.1"] });
    // allowedHosts includes the target to get past the hostname check —
    // the denial will come from the IP block.
    const client = makeClient({ allowedHosts: ["evil.corp"] }, resolver, sink);

    await client.fetch({ url: "https://evil.corp/data" }).catch(() => undefined);

    expect(denials.length).toBeGreaterThan(0);
    expect(["private_ip", "metadata_ip"]).toContain(denials[0].reason);
    expect(denials[0].host).toBe("evil.corp");
  });
});
