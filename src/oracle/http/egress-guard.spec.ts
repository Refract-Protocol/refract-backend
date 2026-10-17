import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyForbiddenIp,
  isForbiddenIpAddress,
  normalizeNumericIpv4Literal,
  validateFeedEgressConfig,
  validateAndResolveEgressTarget,
  scanAdapterSourceForRawHttp,
  EgressDeniedError,
  DEFAULT_PROVIDER_ALLOWLIST,
} from "./egress-guard.ts";
import { ProviderHttpClient } from "./provider-http.client.ts";

test("Issue #286: classifyForbiddenIp blocks metadata, private, loopback, octal/hex/decimal IPv4, IPv4-mapped IPv6, and zone IDs", () => {
  // Cloud metadata & link-local
  assert.equal(isForbiddenIpAddress("169.254.169.254"), true);
  assert.match(classifyForbiddenIp("169.254.169.254") ?? "", /metadata/);

  // Decimal/octal/hex representations of 169.254.169.254 and 127.0.0.1
  assert.equal(normalizeNumericIpv4Literal("2852039166"), "169.254.169.254");
  assert.equal(isForbiddenIpAddress("2852039166"), true);
  assert.equal(normalizeNumericIpv4Literal("0177.0.0.1"), "127.0.0.1");
  assert.equal(isForbiddenIpAddress("0177.0.0.1"), true);
  assert.equal(normalizeNumericIpv4Literal("0x7f.0.0.1"), "127.0.0.1");
  assert.equal(isForbiddenIpAddress("0x7f.0.0.1"), true);

  // RFC1918 and CGNAT
  assert.equal(isForbiddenIpAddress("10.0.0.1"), true);
  assert.equal(isForbiddenIpAddress("172.16.5.4"), true);
  assert.equal(isForbiddenIpAddress("192.168.1.1"), true);
  assert.equal(isForbiddenIpAddress("100.64.0.1"), true);

  // IPv6 loopback, link-local, unique-local, IPv4-mapped metadata, and zone IDs
  assert.equal(isForbiddenIpAddress("::1"), true);
  assert.equal(isForbiddenIpAddress("fe80::1"), true);
  assert.equal(isForbiddenIpAddress("fd00::1234"), true);
  assert.equal(isForbiddenIpAddress("::ffff:169.254.169.254"), true);
  assert.equal(isForbiddenIpAddress("::ffff:127.0.0.1"), true);
  assert.equal(isForbiddenIpAddress("2606:4700:4700::1111%eth0"), true);

  // Public unicast IPv4 and IPv6 are allowed
  assert.equal(isForbiddenIpAddress("104.18.32.7"), false);
  assert.equal(isForbiddenIpAddress("2606:4700:4700::1111"), false);
});

test("Issue #286: validateFeedEgressConfig rejects wildcards, IP literals, and traversal prefixes", () => {
  assert.doesNotThrow(() => validateFeedEgressConfig(DEFAULT_PROVIDER_ALLOWLIST.coingecko));

  assert.throws(
    () =>
      validateFeedEgressConfig({
        adapterId: "bad",
        allowedHosts: [{ hostname: "*.coingecko.com" }],
      }),
    /Invalid allowlist hostname/
  );

  assert.throws(
    () =>
      validateFeedEgressConfig({
        adapterId: "bad-ip",
        allowedHosts: [{ hostname: "169.254.169.254" }],
      }),
    /must be a DNS name/
  );

  assert.throws(
    () =>
      validateFeedEgressConfig({
        adapterId: "bad-path",
        allowedHosts: [{ hostname: "api.coingecko.com", allowedPathPrefixes: ["/api/../admin"] }],
      }),
    /Invalid allowedPathPrefix/
  );
});

test("Issue #286: ProviderHttpClient pins public DNS IPs and rejects metadata rebinding, private redirects, http redirects, oversized bodies, and non-JSON content-types", async () => {
  const deniedEvents: EgressDeniedError[] = [];
  const structuredLogs: Record<string, unknown>[] = [];

  const stubDns = new Map<string, { address: string; family: 4 | 6 }[]>([
    ["api.coingecko.com", [{ address: "104.18.32.7", family: 4 }]],
    ["api.llama.fi", [{ address: "172.67.70.12", family: 4 }]],
    ["rebinding.coingecko.com", [{ address: "169.254.169.254", family: 4 }]],
  ]);

  let hopHandler = async (input: { url: URL; pinnedAddress: { address: string; family: 4 | 6 } }) => ({
    statusCode: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: Buffer.from(JSON.stringify({ usdc: 1.0, ip: input.pinnedAddress.address })),
  });

  const client = new ProviderHttpClient({
    policies: {
      coingecko: {
        adapterId: "coingecko",
        allowedHosts: [
          { hostname: "api.coingecko.com", allowedPathPrefixes: ["/api/v3/"] },
          { hostname: "rebinding.coingecko.com", allowedPathPrefixes: ["/api/v3/"] },
        ],
        maxRedirects: 2,
        maxResponseBytes: 256,
      },
    },
    resolver: async (host) => stubDns.get(host) ?? [],
    transport: (input) => hopHandler(input),
    telemetry: {
      onEgressDenied: (err) => deniedEvents.push(err),
      logStructured: (entry) => structuredLogs.push(entry),
    },
  });

  // 1. Happy path: allowlisted host + path + public IP pinned
  const ok = await client.getJson<{ usdc: number; ip: string }>(
    "coingecko",
    "https://api.coingecko.com/api/v3/simple/price?ids=usd-coin"
  );
  assert.equal(ok.data.usdc, 1.0);
  assert.equal(ok.pinnedIp, "104.18.32.7");

  // 2. Disallowed scheme (http:)
  await assert.rejects(
    () => client.getJson("coingecko", "http://api.coingecko.com/api/v3/simple/price"),
    (err: EgressDeniedError) => err.reason === "disallowed_scheme"
  );

  // 3. DNS rebinding to cloud metadata IP 169.254.169.254
  await assert.rejects(
    () => client.getJson("coingecko", "https://rebinding.coingecko.com/api/v3/simple/price"),
    (err: EgressDeniedError) => err.reason === "private_or_metadata_ip"
  );

  // 4. Redirect to non-allowlisted / private host
  hopHandler = async () => ({
    statusCode: 302,
    headers: { location: "https://169.254.169.254/latest/meta-data/" },
    body: Buffer.alloc(0),
  });
  await assert.rejects(
    () => client.getJson("coingecko", "https://api.coingecko.com/api/v3/simple/price"),
    (err: EgressDeniedError) => err.reason === "private_or_metadata_ip"
  );

  // 5. Redirect downgrade to http://
  hopHandler = async () => ({
    statusCode: 301,
    headers: { location: "http://api.coingecko.com/api/v3/simple/price" },
    body: Buffer.alloc(0),
  });
  await assert.rejects(
    () => client.getJson("coingecko", "https://api.coingecko.com/api/v3/simple/price"),
    (err: EgressDeniedError) => err.reason === "disallowed_scheme"
  );

  // 6. Over-long response body (> 256 bytes)
  hopHandler = async () => ({
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.alloc(512, 0x41),
  });
  await assert.rejects(
    () => client.getJson("coingecko", "https://api.coingecko.com/api/v3/simple/price"),
    (err: EgressDeniedError) => err.reason === "response_too_large"
  );

  // 7. Disallowed content-type (text/html)
  hopHandler = async () => ({
    statusCode: 200,
    headers: { "content-type": "text/html" },
    body: Buffer.from("<html>error</html>"),
  });
  await assert.rejects(
    () => client.getJson("coingecko", "https://api.coingecko.com/api/v3/simple/price"),
    (err: EgressDeniedError) => err.reason === "disallowed_content_type"
  );

  // Telemetry & structured log assertions
  assert.equal(deniedEvents.length, 6);
  assert.equal(structuredLogs.length, 6);
  assert.equal(client.getDeniedCount("coingecko"), 6);
  assert.equal(structuredLogs[0].event, "oracle_egress_denied");
});

test("Issue #286: scanAdapterSourceForRawHttp catches direct fetch() and axios imports", () => {
  const badCode = `
    import axios from "axios";
    export async function poll() {
      const r = await fetch("https://api.coingecko.com");
      return axios.get("https://api.llama.fi");
    }
  `;
  const violations = scanAdapterSourceForRawHttp(badCode, "coingecko.adapter.ts");
  assert.equal(violations.length, 2);

  const cleanCode = `
    import { ProviderHttpClient } from "./http/index.ts";
    export async function poll(client: ProviderHttpClient) {
      return client.getJson("coingecko", "https://api.coingecko.com/api/v3/ping");
    }
  `;
  assert.deepEqual(scanAdapterSourceForRawHttp(cleanCode, "coingecko.adapter.ts"), []);
});
