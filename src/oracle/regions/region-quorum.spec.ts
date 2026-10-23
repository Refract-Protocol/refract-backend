import { InMemoryNonceStore } from "../sources/nonce-store";
import { DEFAULT_QUORUM_CONFIG, RegionProfile, RegionalObservation, evaluateRegionalQuorum } from "./region-quorum";
import { RegionalQuorumAggregator, TrustTransition, parseReport, regionsFromEnv } from "./regional-quorum.aggregator";
import { RegionalPoller, buildSignedReport, classifyFetchError } from "./regional-poller";

const NOW = 1_760_000_000_000;
const FEED = "usdc-usd";
const SECRET = "k".repeat(32);

// Three regions on different infrastructure, plus two that share CDN "edgeco" with us-east.
const PROFILES: RegionProfile[] = [
  { region: "us-east", cdn: "edgeco", dnsProvider: "dns-a", asn: "AS1", cloudProvider: "aws" },
  { region: "eu-west", cdn: "fastnet", dnsProvider: "dns-b", asn: "AS2", cloudProvider: "gcp" },
  { region: "ap-south", cdn: "cloudy", dnsProvider: "dns-c", asn: "AS3", cloudProvider: "azure" },
];

function ok(region: string, value: number, extra: Partial<RegionalObservation> & { upstreamTimestamp?: number } = {}): RegionalObservation {
  const { upstreamTimestamp, ...rest } = extra;
  return {
    region,
    feedId: FEED,
    observedAt: NOW - 1000,
    outcome: { kind: "ok", value, ...(upstreamTimestamp !== undefined ? { upstreamTimestamp } : {}) },
    ...rest,
  };
}

function err(region: string, error: "timeout" | "dns" | "http_5xx" = "timeout"): RegionalObservation {
  return { region, feedId: FEED, observedAt: NOW - 1000, outcome: { kind: "error", error } };
}

const evaluate = (obs: RegionalObservation[], profiles = PROFILES, cfg = DEFAULT_QUORUM_CONFIG) =>
  evaluateRegionalQuorum(FEED, obs, profiles, cfg, NOW);

describe("evaluateRegionalQuorum", () => {
  it("trusts a value when independent regions agree within tolerance, returning their median", () => {
    const v = evaluate([ok("us-east", 0.9990), ok("eu-west", 0.9992), ok("ap-south", 0.9994)]);
    expect(v.trust).toBe("trusted");
    expect(v.value).toBe(0.9992);
    expect(v.agreeingRegions).toEqual(["ap-south", "eu-west", "us-east"]);
  });

  it("is under-corroborated with only one fresh region", () => {
    const v = evaluate([ok("us-east", 0.999), ok("eu-west", 0.999, { observedAt: NOW - 10 * 60_000 })]);
    expect(v.trust).toBe("under_corroborated");
    expect(v.value).toBeNull();
    expect(v.missingRegions).toEqual(["ap-south", "eu-west"]);
  });

  it("flags a dissenting region and stays trusted if the majority agrees", () => {
    const v = evaluate([ok("us-east", 0.999), ok("eu-west", 0.999), ok("ap-south", 0.90)]);
    expect(v.trust).toBe("trusted");
    expect(v.dissentingRegions).toEqual(["ap-south"]);
  });

  it("is disputed when no majority agrees", () => {
    const v = evaluate([ok("us-east", 0.999), ok("eu-west", 0.90)]);
    expect(v.trust).toBe("disputed");
  });

  it("does not count regions behind the same CDN as independent confirmation", () => {
    const sharedCdn: RegionProfile[] = [
      { region: "us-east", cdn: "edgeco", dnsProvider: "dns-a", asn: "AS1" },
      { region: "us-west", cdn: "edgeco", dnsProvider: "dns-b", asn: "AS2" },
      { region: "eu-west", cdn: "fastnet", dnsProvider: "dns-c", asn: "AS3" },
    ];
    const v = evaluate([ok("us-east", 0.999), ok("us-west", 0.999), err("eu-west")], sharedCdn);
    expect(v.trust).toBe("under_corroborated");
    expect(v.reasons.join(" ")).toMatch(/share cdn/);
  });

  it("treats unknown infrastructure as shared, not independent", () => {
    const unknown: RegionProfile[] = [{ region: "a" }, { region: "b" }];
    const v = evaluate([ok("a", 1), ok("b", 1)].map((o) => ({ ...o })), unknown);
    expect(v.trust).toBe("under_corroborated");
  });

  it("detects a shared CDN outage and reports the feed as degraded", () => {
    const profiles: RegionProfile[] = [
      { region: "us-east", cdn: "edgeco", dnsProvider: "dns-a", asn: "AS1" },
      { region: "us-west", cdn: "edgeco", dnsProvider: "dns-b", asn: "AS2" },
      { region: "eu-west", cdn: "edgeco", dnsProvider: "dns-c", asn: "AS3" },
      { region: "ap-south", cdn: "cloudy", dnsProvider: "dns-d", asn: "AS4" },
    ];
    const v = evaluate([err("us-east", "http_5xx"), err("us-west", "http_5xx"), err("eu-west", "timeout"), ok("ap-south", 0.999)], profiles);
    expect(v.trust).toBe("degraded");
    expect(v.correlatedFailures).toContainEqual({
      dimension: "cdn",
      value: "edgeco",
      regions: ["eu-west", "us-east", "us-west"],
      errorKinds: ["http_5xx", "timeout"],
    });
  });

  it("detects a DNS provider failure, counting silent regions as down", () => {
    const profiles: RegionProfile[] = [
      { region: "r1", cdn: "c1", dnsProvider: "dns-x", asn: "AS1" },
      { region: "r2", cdn: "c2", dnsProvider: "dns-x", asn: "AS2" },
      { region: "r3", cdn: "c3", dnsProvider: "dns-y", asn: "AS3" },
    ];
    const v = evaluate([err("r1", "dns"), ok("r3", 1)], profiles); // r2 silent
    expect(v.trust).toBe("degraded");
    expect(v.correlatedFailures.find((c) => c.dimension === "dnsProvider")).toMatchObject({ value: "dns-x", regions: ["r1", "r2"] });
  });

  it("detects the same error in every region regardless of infrastructure", () => {
    const v = evaluate([err("us-east", "http_5xx"), err("eu-west", "http_5xx"), err("ap-south", "http_5xx")]);
    expect(v.trust).toBe("degraded");
    expect(v.correlatedFailures).toContainEqual(expect.objectContaining({ dimension: "error_kind", value: "http_5xx" }));
  });

  it("marks agreement on a frozen upstream value (shared stale cache) as degraded", () => {
    const stale = NOW - 60 * 60_000;
    const v = evaluate([ok("us-east", 1, { upstreamTimestamp: stale }), ok("eu-west", 1, { upstreamTimestamp: stale }), ok("ap-south", 1, { upstreamTimestamp: stale })]);
    expect(v.trust).toBe("degraded");
    expect(v.correlatedFailures[0]).toMatchObject({ dimension: "stale_upstream" });
  });

  it("stays trusted through a correlated failure if enough independent regions still agree", () => {
    const profiles: RegionProfile[] = [
      { region: "a", cdn: "edgeco", dnsProvider: "d1", asn: "AS1" },
      { region: "b", cdn: "edgeco", dnsProvider: "d2", asn: "AS2" },
      { region: "c", cdn: "fastnet", dnsProvider: "d3", asn: "AS3" },
      { region: "d", cdn: "cloudy", dnsProvider: "d4", asn: "AS4" },
    ];
    const v = evaluate([err("a"), err("b"), ok("c", 1), ok("d", 1)], profiles);
    expect(v.trust).toBe("trusted");
    expect(v.correlatedFailures.map((c) => c.dimension)).toContain("cdn");
  });

  it("ignores observations from unregistered regions and other feeds", () => {
    const v = evaluate([ok("rogue", 0.5), ok("us-east", 0.999), { ...ok("eu-west", 0.999), feedId: "other" }]);
    expect(v.trust).toBe("under_corroborated");
    expect(v.agreeingRegions).toEqual(["us-east"]);
  });

  it("is deterministic regardless of input order", () => {
    const obs = [ok("us-east", 0.999), ok("eu-west", 0.998), err("ap-south")];
    expect(evaluate(obs)).toEqual(evaluate([...obs].reverse()));
  });
});

describe("RegionalQuorumAggregator", () => {
  function setup() {
    const agg = new RegionalQuorumAggregator(DEFAULT_QUORUM_CONFIG, new InMemoryNonceStore());
    for (const p of PROFILES) agg.registerRegion({ ...p, keys: [{ keyId: "k1", secret: SECRET + p.region }] });
    const transitions: TrustTransition[] = [];
    agg.onTrustTransition((t) => {
      transitions.push(t);
    });
    const report = (region: string, observations: unknown[], opts: { secret?: string; now?: number; nonce?: string } = {}) => {
      const signedFor = buildSignedReport(region, { keyId: "k1", secret: opts.secret ?? SECRET + region }, observations, opts.now ?? NOW, opts.nonce);
      return agg.ingestSignedReport(region, { headers: signedFor.headers, rawBody: signedFor.body }, opts.now ?? NOW);
    };
    return { agg, transitions, report };
  }

  it("authenticates region reports and emits trust transitions", async () => {
    const { agg, transitions, report } = setup();
    expect(await report("us-east", [{ feedId: FEED, observedAt: NOW - 500, value: 0.999 }])).toMatchObject({ ok: true, recorded: 1 });
    await report("eu-west", [{ feedId: FEED, observedAt: NOW - 500, value: 0.999 }]);
    expect(transitions.map((t) => [t.from, t.to])).toEqual([
      [null, "under_corroborated"],
      ["under_corroborated", "trusted"],
    ]);
    expect(agg.trustedValue(FEED, NOW)).toBe(0.999);
  });

  it("rejects a region signing with another region's key, and replays", async () => {
    const { report } = setup();
    expect(await report("us-east", [{ feedId: FEED, observedAt: NOW, value: 1 }], { secret: SECRET + "eu-west" })).toMatchObject({
      ok: false,
      status: 401,
      reason: "bad_signature",
    });
    const nonce = "n".repeat(20);
    expect((await report("us-east", [{ feedId: FEED, observedAt: NOW - 1, value: 1 }], { nonce })).ok).toBe(true);
    expect(await report("us-east", [{ feedId: FEED, observedAt: NOW - 1, value: 1 }], { nonce })).toMatchObject({ reason: "replayed_nonce" });
  });

  it("rejects unknown regions and malformed bodies", async () => {
    const { agg, report } = setup();
    expect(await agg.ingestSignedReport("mars", { headers: {}, rawBody: Buffer.from("{}") }, NOW)).toMatchObject({ status: 401 });
    expect(await report("us-east", [{ feedId: FEED, observedAt: NOW, value: "1" }])).toMatchObject({ status: 400 });
  });

  it("notices regions going silent on a sweep", async () => {
    const { agg, transitions, report } = setup();
    for (const r of ["us-east", "eu-west", "ap-south"]) await report(r, [{ feedId: FEED, observedAt: NOW - 500, value: 1 }]);
    expect(agg.trustState(FEED)).toBe("trusted");
    await agg.evaluateAll(NOW + 10 * 60_000);
    expect(agg.trustState(FEED)).not.toBe("trusted");
    expect(transitions.at(-1)?.to).toBe("degraded"); // every region went silent at once
  });

  it("drops out-of-order reports per region", () => {
    const { agg } = setup();
    expect(agg.record(ok("us-east", 1, { observedAt: NOW }))).toBe(true);
    expect(agg.record(ok("us-east", 2, { observedAt: NOW - 1 }))).toBe(false);
  });

  it("falls back to ungated behavior with a visible warning in a single-region deployment", async () => {
    const agg = new RegionalQuorumAggregator();
    agg.registerRegion({ ...PROFILES[0], keys: [{ keyId: "k1", secret: SECRET }] });
    agg.record(ok("us-east", 0.999, { observedAt: NOW - 100 }));
    await agg.evaluate(FEED, NOW);
    expect(agg.peek(FEED, NOW).trust).toBe("under_corroborated");
    expect(agg.trustState(FEED)).toBeNull(); // claims are not held
    expect(agg.quorumStatus()).toMatchObject({ quorumEnforced: false, registeredRegions: 1 });
    expect(agg.quorumStatus().warning).toMatch(/NOT regionally corroborated/);
  });

  it("gates claims once enough regions are registered", async () => {
    const { agg, report } = setup();
    await report("us-east", [{ feedId: FEED, observedAt: NOW - 500, value: 1 }]);
    expect(agg.quorumStatus().quorumEnforced).toBe(true);
    expect(agg.trustState(FEED)).toBe("under_corroborated");
  });

  it("refuses bad region registrations", () => {
    const agg = new RegionalQuorumAggregator();
    expect(() => agg.registerRegion({ region: "US EAST", keys: [{ keyId: "k", secret: SECRET }] })).toThrow();
    expect(() => agg.registerRegion({ region: "us-east", keys: [{ keyId: "k", secret: "short" }] })).toThrow();
  });

  it("parses reports using the signed region, never one from the body", () => {
    const [o] = parseReport("us-east", { observations: [{ feedId: FEED, observedAt: NOW, value: 1, region: "eu-west" }] });
    expect(o.region).toBe("us-east");
    expect(() => parseReport("us-east", { observations: [{ feedId: FEED, observedAt: NOW, error: "bogus" }] })).toThrow();
  });

  it("reads ORACLE_REGIONS", () => {
    expect(regionsFromEnv(JSON.stringify([{ region: "us-east", cdn: "x", keys: [] }]))[0].region).toBe("us-east");
    expect(() => regionsFromEnv("{}")).toThrow();
    expect(regionsFromEnv("")).toEqual([]);
  });
});

describe("RegionalPoller", () => {
  it("reports successes and classified failures in one signed report", async () => {
    const posted: Array<{ path: string; body: string }> = [];
    const poller = new RegionalPoller(
      "us-east",
      { keyId: "k1", secret: SECRET },
      [
        { feedId: "a", fetch: async () => ({ value: 1, upstreamTimestamp: NOW - 5 }) },
        { feedId: "b", fetch: async () => Promise.reject(Object.assign(new Error("x"), { code: "ENOTFOUND" })) },
        { feedId: "c", fetch: async () => ({ value: NaN }) },
      ],
      { post: async (path, _h, body) => void posted.push({ path, body: body.toString() }) },
      () => NOW,
    );
    await poller.pollOnce();
    expect(posted[0].path).toBe("/api/v1/oracle/regions/us-east/observations");
    expect(JSON.parse(posted[0].body).observations).toEqual([
      { feedId: "a", observedAt: NOW, value: 1, upstreamTimestamp: NOW - 5 },
      { feedId: "b", observedAt: NOW, error: "dns" },
      { feedId: "c", observedAt: NOW, error: "invalid_response" },
    ]);
  });

  it.each([
    [{ status: 503 }, "http_5xx"],
    [{ response: { status: 404 } }, "http_4xx"],
    [{ code: "ETIMEDOUT" }, "timeout"],
    [{ name: "AbortError" }, "timeout"],
    [{ code: "ECONNRESET" }, "connection"],
    [{ code: "CERT_HAS_EXPIRED" }, "tls"],
    [new Error("weird"), "invalid_response"],
  ])("classifies %j as %s", (e, kind) => {
    expect(classifyFetchError(e)).toBe(kind);
  });
});
