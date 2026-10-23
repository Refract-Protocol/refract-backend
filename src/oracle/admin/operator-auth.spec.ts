import { FixedWindowLimiter, operatorRateLimitsFromEnv } from "./actor-rate-limiter";
import { OracleAuditLog, runWithAuditContext, AuditContext } from "./oracle-audit";
import {
  ControlConflictError,
  ControlNotFoundError,
  ControlValidationError,
  MAX_MANUAL_OVERRIDE_MS,
  OracleControlRegistry,
} from "./oracle-control.registry";
import {
  OperatorAuthError,
  OperatorAuthenticator,
  ROLE_PERMISSIONS,
  generateOperatorKey,
  hashSecret,
  parseOperatorCredentials,
} from "./operator-identity";
import { OracleConfigFile } from "../config/oracle-feed-config";

const NOW = Date.UTC(2026, 9, 21, 12);

describe("operator credentials", () => {
  it("parses a valid key list and rejects malformed or duplicate entries", () => {
    const { credential } = generateOperatorKey("ops-alice", "alice@refract", "oracle:operator");
    expect(parseOperatorCredentials(JSON.stringify([credential]))).toEqual([credential]);
    expect(parseOperatorCredentials(undefined)).toEqual([]);
    expect(() => parseOperatorCredentials("{")).toThrow(/not valid JSON/);
    expect(() => parseOperatorCredentials(JSON.stringify([{ ...credential, role: "root" }]))).toThrow(/role/);
    expect(() => parseOperatorCredentials(JSON.stringify([{ ...credential, secretSha256: "abc" }]))).toThrow(
      /secretSha256/
    );
    expect(() => parseOperatorCredentials(JSON.stringify([credential, credential]))).toThrow(/more than once/);
  });

  it("never stores the secret, only its hash", () => {
    const { token, credential } = generateOperatorKey("ops-bob", "bob", "oracle:admin");
    const secret = token.split(".")[1];
    expect(JSON.stringify(credential)).not.toContain(secret);
    expect(credential.secretSha256).toBe(hashSecret(secret));
  });

  it("grants least privilege by role", () => {
    expect(ROLE_PERMISSIONS["oracle:viewer"]).toEqual(["feeds:read"]);
    expect(ROLE_PERMISSIONS["oracle:operator"]).not.toContain("manual:override");
    expect(ROLE_PERMISSIONS["oracle:operator"]).not.toContain("quorum:write");
    expect(ROLE_PERMISSIONS["oracle:admin"]).toContain("manual:override");
  });
});

describe("OperatorAuthenticator", () => {
  const alice = generateOperatorKey("ops-alice", "alice", "oracle:operator");
  const expired = generateOperatorKey("ops-old", "carol", "oracle:admin");
  const disabled = generateOperatorKey("ops-off", "dave", "oracle:admin");
  const auth = new OperatorAuthenticator(
    [
      alice.credential,
      { ...expired.credential, expiresAt: new Date(NOW - 1).toISOString() },
      { ...disabled.credential, disabled: true },
    ],
    () => NOW
  );
  const reason = (header: string | undefined) => {
    try {
      auth.authenticate(header);
      return "ok";
    } catch (error) {
      return (error as OperatorAuthError).reason;
    }
  };

  it("resolves a valid token to the actor, role, and key", () => {
    expect(auth.authenticate(`Bearer ${alice.token}`)).toEqual({
      actor: "alice",
      role: "oracle:operator",
      keyId: "ops-alice",
      permissions: ROLE_PERMISSIONS["oracle:operator"],
    });
  });

  it.each([
    [undefined, "missing_credentials"],
    ["Basic abc", "malformed_token"],
    ["Bearer no-dot-here", "malformed_token"],
    ["Bearer ghost.AAAAAAAAAAAAAAAAAAAAAAAA", "unknown_key"],
    ["Bearer ops-alice.AAAAAAAAAAAAAAAAAAAAAAAA", "invalid_secret"],
  ])("rejects %p as %s", (header, expected) => {
    expect(reason(header)).toBe(expected);
  });

  it("rejects expired and disabled keys even with the right secret", () => {
    expect(reason(`Bearer ${expired.token}`)).toBe("key_expired");
    expect(reason(`Bearer ${disabled.token}`)).toBe("key_disabled");
  });
});

describe("FixedWindowLimiter", () => {
  it("allows up to the limit per identity and resets after the window", () => {
    let clock = NOW;
    const limiter = new FixedWindowLimiter(() => clock);
    const budget = { limit: 2, windowMs: 60_000 };

    expect(limiter.hit("a", budget).allowed).toBe(true);
    expect(limiter.hit("a", budget).allowed).toBe(true);
    const third = limiter.hit("a", budget);
    expect(third).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 60 });
    expect(limiter.hit("b", budget).allowed).toBe(true);

    clock += 60_000;
    expect(limiter.hit("a", budget).allowed).toBe(true);
  });

  it("peek does not consume budget", () => {
    const limiter = new FixedWindowLimiter(() => NOW);
    const budget = { limit: 1, windowMs: 1_000 };
    limiter.peek("a", budget);
    expect(limiter.hit("a", budget).allowed).toBe(true);
    expect(limiter.peek("a", budget).allowed).toBe(false);
  });

  it("reads budgets from the environment with safe fallbacks", () => {
    const limits = operatorRateLimitsFromEnv({
      ORACLE_OPERATOR_WRITE_LIMIT_PER_MIN: "5",
      ORACLE_OPERATOR_READ_LIMIT_PER_MIN: "-3",
    });
    expect(limits.write.limit).toBe(5);
    expect(limits.read.limit).toBe(120);
  });
});

describe("OracleAuditLog", () => {
  it("keeps a bounded, most-recent-first history and forwards to the sink", () => {
    const sink = { write: jest.fn() };
    const log = new OracleAuditLog(sink, 2);
    for (const action of ["a", "b", "c"]) {
      log.write({ action } as never);
    }
    expect(log.list().map((e) => e.action)).toEqual(["c", "b"]);
    expect(sink.write).toHaveBeenCalledTimes(3);
  });
});

describe("OracleControlRegistry", () => {
  const config: OracleConfigFile = {
    version: 1,
    defaults: { trustMode: "median_quorum" },
    feeds: [
      {
        id: "depeg",
        coverageType: "StablecoinDepeg",
        quorum: { minSources: 2 },
        sources: [
          { id: "a", adapter: "coingecko", operator: "coingecko" },
          { id: "b", adapter: "horizon", operator: "sdex" },
          { id: "c", adapter: "defillama", operator: "llama" },
        ],
      },
    ],
  };
  const context = (): AuditContext => ({
    requestId: "r1",
    actor: "alice",
    role: "oracle:admin",
    keyId: "k1",
    ip: "127.0.0.1",
    changes: [],
  });

  function make(onSourcesAdded = jest.fn()) {
    let clock = NOW;
    const registry = new OracleControlRegistry(config, {
      network: "testnet",
      now: () => clock,
      onSourcesAdded,
    });
    return { registry, onSourcesAdded, advance: (ms: number) => (clock += ms) };
  }

  it("stamps changes with the actor from the audit context and records before/after", () => {
    const { registry } = make();
    const ctx = context();

    const state = runWithAuditContext(ctx, () => registry.pause("depeg", "upstream incident"));

    expect(state).toMatchObject({ paused: true, by: "alice", reason: "upstream incident" });
    expect(registry.isPaused("depeg")).toBe(true);
    expect(ctx.changes).toEqual([
      { entity: "pause", id: "depeg", before: null, after: expect.objectContaining({ paused: true }) },
    ]);
  });

  it("attributes changes outside a request to system", () => {
    const { registry } = make();
    expect(registry.resume("depeg", null).by).toBe("system");
  });

  it("rejects quorum edits the startup validator would reject", () => {
    const { registry } = make();
    expect(() => registry.updateQuorum("depeg", { minSources: 5 })).toThrow(ControlValidationError);
    try {
      registry.updateQuorum("depeg", { minSources: 5 });
    } catch (error) {
      expect((error as ControlValidationError).issues.map((i) => i.code)).toContain(
        "QUORUM_EXCEEDS_INDEPENDENT_SOURCES"
      );
    }
    expect(registry.getFeed("depeg").definition.quorum?.minSources).toBe(2);
  });

  it("returns validator warnings without blocking", () => {
    const { registry } = make();
    const result = registry.updateQuorum("depeg", { minSources: 3 });
    expect(result.value.revision).toBe(2);
    expect(result.warnings.map((w) => w.code)).toContain("NO_QUORUM_HEADROOM");
  });

  it("enforces optimistic concurrency with expectedRevision", () => {
    const { registry } = make();
    registry.updateQuorum("depeg", { minSources: 2, maxDeviationBps: 50 }, 1);
    expect(() => registry.updateQuorum("depeg", { minSources: 2 }, 1)).toThrow(ControlConflictError);
  });

  it("reports added sources for bootstrapping when a feed is onboarded or extended", () => {
    const { registry, onSourcesAdded } = make();
    registry.upsertFeed("crash", {
      id: "crash",
      coverageType: "MarketCrash",
      quorum: { minSources: 2 },
      sources: [
        { id: "x", adapter: "coingecko", operator: "coingecko" },
        { id: "y", adapter: "horizon", operator: "sdex" },
        { id: "z", adapter: "defillama", operator: "llama", enabled: false },
      ],
    });
    expect(onSourcesAdded).toHaveBeenLastCalledWith("crash", [
      expect.objectContaining({ id: "x" }),
      expect.objectContaining({ id: "y" }),
    ]);

    const depeg = registry.getFeed("depeg").definition;
    registry.upsertFeed("depeg", { ...depeg, sources: [...depeg.sources, { id: "d", adapter: "coingecko", operator: "cg2" }] });
    expect(onSourcesAdded).toHaveBeenLastCalledWith("depeg", [expect.objectContaining({ id: "d" })]);
  });

  it("rejects a body id that does not match the path", () => {
    const { registry } = make();
    expect(() => registry.upsertFeed("depeg", { ...config.feeds[0], id: "other" })).toThrow(/does not match/);
  });

  it("validates quarantine overrides against the feed's sources and honours expiry", () => {
    const { registry, advance } = make();
    expect(() =>
      registry.setQuarantineOverride("depeg", "nope", { action: "release", reason: "x" })
    ).toThrow(ControlNotFoundError);

    registry.setQuarantineOverride("depeg", "a", {
      action: "quarantine",
      reason: "stale prices",
      expiresAt: new Date(NOW + 60_000).toISOString(),
    });
    expect(registry.quarantineOverride("depeg", "a")?.action).toBe("quarantine");
    advance(60_000);
    expect(registry.quarantineOverride("depeg", "a")).toBeNull();
  });

  it("bounds manual overrides to finite values that expire within 24 hours", () => {
    const { registry, advance } = make();
    const inOneHour = new Date(NOW + 3_600_000).toISOString();
    expect(() =>
      registry.setManualOverride("depeg", {
        value: 1,
        reason: "x",
        expiresAt: new Date(NOW + MAX_MANUAL_OVERRIDE_MS + 1).toISOString(),
      })
    ).toThrow(/24 hours/);
    expect(() =>
      registry.setManualOverride("depeg", { value: 1, reason: "x", expiresAt: new Date(NOW - 1).toISOString() })
    ).toThrow(/future/);

    registry.setManualOverride("depeg", { value: 0.97, reason: "incident", expiresAt: inOneHour });
    expect(registry.activeManualOverride("depeg")?.value).toBe(0.97);
    advance(3_600_000);
    expect(registry.activeManualOverride("depeg")).toBeNull();
  });

  it("clears runtime controls when a feed is deleted", () => {
    const { registry } = make();
    registry.upsertFeed("crash", {
      id: "crash",
      coverageType: "MarketCrash",
      quorum: { minSources: 2 },
      sources: [
        { id: "x", adapter: "coingecko", operator: "coingecko" },
        { id: "y", adapter: "horizon", operator: "sdex" },
      ],
    });
    registry.pause("crash", "maintenance");
    registry.deleteFeed("crash");
    expect(registry.isPaused("crash")).toBe(false);
    expect(() => registry.getFeed("crash")).toThrow(ControlNotFoundError);
  });
});
