import { AllEndpointsFailedError, ProviderEndpointSet, redactUrl } from "./provider-endpoints";
import { loadEndpointDeclarations, loadEndpointOptions, parseEndpointList } from "./provider-endpoints.config";
import { ProviderEndpointRegistry } from "./provider-endpoint.registry";

const OPTIONS = { failureThreshold: 2, cooldownMs: 1_000, maxCooldownMs: 4_000, slowMs: 500, attemptTimeoutMs: 50 };
const ENDPOINTS = [
  { label: "primary", url: "https://primary.example" },
  { label: "mirror", url: "https://mirror.example" },
  { label: "eu", url: "https://eu.example" },
];

function setup() {
  let now = 0;
  const set = new ProviderEndpointSet("coingecko", ENDPOINTS, OPTIONS, () => now);
  const down = new Set<string>();
  const calls: string[] = [];
  const call = async (baseUrl: string) => {
    calls.push(baseUrl);
    if (down.has(baseUrl)) throw new Error("ECONNREFUSED");
    return `ok:${baseUrl}`;
  };
  return { set, down, calls, call, advance: (ms: number) => (now += ms) };
}

describe("ProviderEndpointSet", () => {
  it("uses the primary while it is healthy", async () => {
    const { set, call, calls } = setup();
    await set.execute(call);
    await set.execute(call);
    expect(calls).toEqual(["https://primary.example", "https://primary.example"]);
  });

  it("fails over within a single call when the primary is unreachable", async () => {
    const { set, call, down } = setup();
    down.add("https://primary.example");
    await expect(set.execute(call)).resolves.toBe("ok:https://mirror.example");
  });

  it("prefers a mirror briefly after one failure, then gives the primary traffic again", async () => {
    const { set, call, calls, down, advance } = setup();
    down.add("https://primary.example");
    await set.execute(call);
    expect(set.snapshot().endpoints[0].status).toBe("degraded");
    calls.length = 0;
    await set.execute(call);
    expect(calls).toEqual(["https://mirror.example"]);

    advance(1_000);
    down.delete("https://primary.example");
    calls.length = 0;
    await set.execute(call);
    expect(calls).toEqual(["https://primary.example"]);
    expect(set.snapshot().endpoints[0].status).toBe("healthy");
  });

  it("takes an endpoint that keeps failing out of rotation, then probes it after the cooldown", async () => {
    const { set, call, calls, down, advance } = setup();
    down.add("https://primary.example");
    await set.execute(call);
    advance(1_000);
    await set.execute(call); // second consecutive failure takes primary down
    expect(set.snapshot().endpoints[0].status).toBe("down");
    calls.length = 0;

    await set.execute(call);
    expect(calls).toEqual(["https://mirror.example"]);
    expect(set.snapshot().active).toBe("mirror");

    advance(1_000);
    expect(set.snapshot().endpoints[0].status).toBe("probing");
    down.delete("https://primary.example");
    calls.length = 0;
    await set.execute(call);
    expect(calls).toEqual(["https://primary.example"]);
    expect(set.snapshot()).toMatchObject({ active: "primary" });
  });

  it("fails a probe over to the mirror within the same call", async () => {
    const { set, call, calls, down, advance } = setup();
    down.add("https://primary.example");
    await set.execute(call);
    advance(1_000);
    await set.execute(call);
    advance(1_000);
    calls.length = 0;
    await expect(set.execute(call)).resolves.toBe("ok:https://mirror.example");
    expect(calls).toEqual(["https://primary.example", "https://mirror.example"]);
    expect(set.snapshot().endpoints[0].status).toBe("down");
  });

  it("takes a probing endpoint that fails again down for a longer cooldown", async () => {
    const { set, call, down, advance } = setup();
    down.add("https://primary.example");
    down.add("https://mirror.example");
    down.add("https://eu.example");
    await expect(set.execute(call)).rejects.toThrow(AllEndpointsFailedError);
    await expect(set.execute(call)).rejects.toThrow(AllEndpointsFailedError);
    expect(set.snapshot().endpoints.every((e) => e.status === "down")).toBe(true);

    advance(1_000);
    expect(set.snapshot().endpoints[0].status).toBe("probing");
    await expect(set.execute(call)).rejects.toThrow();
    advance(1_500);
    expect(set.snapshot().endpoints[0].status).toBe("down"); // cooldown doubled to 2s
  });

  it("still tries the endpoint that recovers soonest when all are down", async () => {
    const { set, call, calls, down } = setup();
    ENDPOINTS.forEach((e) => down.add(e.url));
    await set.execute(call).catch(() => undefined);
    await set.execute(call).catch(() => undefined);
    calls.length = 0;
    down.clear();
    await expect(set.execute(call)).resolves.toBe("ok:https://primary.example");
    expect(calls).toHaveLength(1);
  });

  it("times out a hanging endpoint and aborts its request", async () => {
    const set = new ProviderEndpointSet("x", ENDPOINTS.slice(0, 2), OPTIONS);
    let aborted = false;
    const result = await set.execute((baseUrl, signal) => {
      if (baseUrl.includes("primary")) {
        signal.addEventListener("abort", () => (aborted = true));
        return new Promise<string>(() => undefined);
      }
      return Promise.resolve("mirror");
    });
    expect(result).toBe("mirror");
    expect(aborted).toBe(true);
    expect(set.snapshot().endpoints[0].lastError).toMatch(/timed out/);
  });

  it("does not fail over or penalise health for non-retryable errors", async () => {
    const { set } = setup();
    const bad = new Error("400 Bad Request");
    await expect(set.execute(() => Promise.reject(bad), { shouldFailover: (e) => e !== bad })).rejects.toBe(bad);
    expect(set.snapshot().endpoints[0]).toMatchObject({ status: "healthy", failures: 0 });
  });

  it("reports demotion and restoration transitions", async () => {
    let now = 0;
    const transitions: string[] = [];
    const set = new ProviderEndpointSet("cg", ENDPOINTS.slice(0, 2), OPTIONS, () => now, (t) =>
      transitions.push(`${t.label}:${t.from}->${t.to}`),
    );
    let primaryUp = false;
    const call = async (u: string) => {
      if (u.includes("primary") && !primaryUp) throw new Error("down");
      return u;
    };
    await set.execute(call);
    now += 1_000;
    await set.execute(call);
    now += 1_000;
    primaryUp = true;
    await set.execute(call);
    expect(transitions).toEqual([
      "primary:healthy->degraded",
      "primary:healthy->down",
      "primary:probing->healthy",
    ]);
  });

  it("marks a slow but working endpoint as degraded and prefers a faster one", async () => {
    let now = 0;
    const set = new ProviderEndpointSet("x", ENDPOINTS.slice(0, 2), { ...OPTIONS, attemptTimeoutMs: 10_000 }, () => now);
    await set.execute(async () => {
      now += 900;
      return 1;
    });
    expect(set.snapshot().endpoints[0].status).toBe("degraded");
    expect(set.order()[0].label).toBe("mirror");
  });
});

describe("endpoint configuration", () => {
  it("parses labelled and unlabelled entries in priority order", () => {
    expect(parseEndpointList("coingecko", "https://a.example/, eu=https://b.example/api, https://c.example")).toEqual([
      { label: "primary", url: "https://a.example" },
      { label: "eu", url: "https://b.example/api" },
      { label: "fallback-2", url: "https://c.example" },
    ]);
  });

  it("rejects invalid URLs and duplicate labels", () => {
    expect(() => parseEndpointList("coingecko", "nope")).toThrow(/not a valid URL/);
    expect(() => parseEndpointList("coingecko", "a=https://x.example,a=https://y.example")).toThrow(/duplicate/);
    expect(() => parseEndpointList("coingecko", "ftp://x.example")).toThrow(/http/);
  });

  it("falls back to the single-URL settings and network-specific Horizon", () => {
    const d = loadEndpointDeclarations({ COINGECKO_BASE_URL: "https://cg.example", STELLAR_NETWORK: "mainnet" });
    expect(d.coingecko).toEqual([{ label: "primary", url: "https://cg.example" }]);
    expect(d.horizon[0].url).toBe("https://horizon.stellar.org");
    expect(d.defillama[0].url).toBe("https://api.llama.fi");
  });

  it("uses ORACLE_ENDPOINTS_<ADAPTER> when set", () => {
    const d = loadEndpointDeclarations({ ORACLE_ENDPOINTS_HORIZON: "https://h1.example,https://h2.example" });
    expect(d.horizon.map((e) => e.url)).toEqual(["https://h1.example", "https://h2.example"]);
  });

  it("defaults the attempt timeout to ORACLE_HTTP_TIMEOUT_MS", () => {
    expect(loadEndpointOptions({ ORACLE_HTTP_TIMEOUT_MS: "1234" }).attemptTimeoutMs).toBe(1234);
  });

  it("redacts credentials and query strings in health output", () => {
    expect(redactUrl("https://user:pw@api.example/v3?x_cg_pro_api_key=secret")).toBe("https://api.example/v3");
    const registry = new ProviderEndpointRegistry({ COINGECKO_BASE_URL: "https://api.example/v3?key=secret" });
    expect(JSON.stringify(registry.snapshot())).not.toContain("secret");
  });
});
