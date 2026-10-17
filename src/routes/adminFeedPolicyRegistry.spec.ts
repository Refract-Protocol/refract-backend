import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AdminFeedPolicyRegistry,
  type OracleFeedPolicyDefinition,
} from "./adminFeedPolicyRegistry.ts";

describe("Admin API for Managing Oracle Feed Definitions and Quorum Policies (#196)", () => {
  it("enforces operator auth, optimistic concurrency, and quorum satisfiability while maintaining auditable version history", () => {
    const notifications: OracleFeedPolicyDefinition[] = [];
    const registry = new AdminFeedPolicyRegistry({
      authorizedOperators: ["ops-alice", "ops-bob"],
      onPolicyChanged: (p) => notifications.push(p),
    });

    // 1. Unauthorized operator is rejected with 401
    const unauth = registry.upsertFeedPolicy({
      actorId: "intruder",
      reason: "malicious edit",
      coverageType: "stablecoin-depeg",
      sources: [
        { sourceId: "coingecko", weight: 50, enabled: true },
        { sourceId: "pyth", weight: 50, enabled: true },
      ],
      quorumThresholdWeight: 60,
      minDistinctSources: 2,
      freshnessWindowMs: 60_000,
      trustMode: "corroborated_multi_source",
      enabled: true,
      nowMs: 1_700_000_000_000,
    });
    assert.equal(unauth.httpStatus, 401);
    assert.equal(unauth.errorCode, "UNAUTHORIZED_OPERATOR");

    // 2. Valid initial creation (v1) succeeds with 201
    const v1 = registry.upsertFeedPolicy({
      actorId: "ops-alice",
      reason: "initial corroborated policy",
      coverageType: "stablecoin-depeg",
      sources: [
        { sourceId: "coingecko", weight: 50, enabled: true },
        { sourceId: "pyth", weight: 50, enabled: true },
        { sourceId: "horizon-dex", weight: 50, enabled: true },
      ],
      quorumThresholdWeight: 100,
      minDistinctSources: 2,
      freshnessWindowMs: 60_000,
      trustMode: "corroborated_multi_source",
      enabled: true,
      nowMs: 1_700_000_001_000,
    });
    assert.equal(v1.httpStatus, 201);
    assert.equal(v1.policy?.version, 1);
    assert.equal(notifications.length, 1);

    // 3. Rejects mutation that leaves enabled feed unable to satisfy its own quorum threshold (422)
    const unsatisfiable = registry.upsertFeedPolicy({
      actorId: "ops-bob",
      reason: "disable two sources while keeping threshold 100",
      expectedVersion: 1,
      coverageType: "stablecoin-depeg",
      sources: [
        { sourceId: "coingecko", weight: 50, enabled: true },
        { sourceId: "pyth", weight: 50, enabled: false },
        { sourceId: "horizon-dex", weight: 50, enabled: false },
      ],
      quorumThresholdWeight: 100,
      minDistinctSources: 2,
      freshnessWindowMs: 60_000,
      trustMode: "corroborated_multi_source",
      enabled: true,
      nowMs: 1_700_000_005_000,
    });
    assert.equal(unsatisfiable.httpStatus, 422);
    assert.equal(unsatisfiable.errorCode, "UNSATISFIABLE_QUORUM_POLICY");

    // 4. Valid update (v2) with expectedVersion=1 succeeds; stale expectedVersion=1 after that returns 409
    const v2 = registry.upsertFeedPolicy({
      actorId: "ops-bob",
      reason: "quarantine horizon-dex and lower threshold to 80",
      expectedVersion: 1,
      coverageType: "stablecoin-depeg",
      sources: [
        { sourceId: "coingecko", weight: 50, enabled: true },
        { sourceId: "pyth", weight: 50, enabled: true },
        { sourceId: "horizon-dex", weight: 50, enabled: false },
      ],
      quorumThresholdWeight: 80,
      minDistinctSources: 2,
      freshnessWindowMs: 45_000,
      trustMode: "corroborated_multi_source",
      enabled: true,
      nowMs: 1_700_000_010_000,
    });
    assert.equal(v2.httpStatus, 200);
    assert.equal(v2.policy?.version, 2);

    const staleConflict = registry.upsertFeedPolicy({
      actorId: "ops-alice",
      reason: "concurrent edit with stale version 1",
      expectedVersion: 1,
      coverageType: "stablecoin-depeg",
      sources: [
        { sourceId: "coingecko", weight: 50, enabled: true },
        { sourceId: "pyth", weight: 50, enabled: true },
      ],
      quorumThresholdWeight: 80,
      minDistinctSources: 2,
      freshnessWindowMs: 45_000,
      trustMode: "corroborated_multi_source",
      enabled: true,
      nowMs: 1_700_000_012_000,
    });
    assert.equal(staleConflict.httpStatus, 409);
    assert.equal(staleConflict.errorCode, "VERSION_CONFLICT");

    // 5. Point-in-time policy lookup returns v1 at t=1_700_000_005_000 and v2 at t=1_700_000_015_000
    assert.equal(
      registry.getPolicyAtTimestamp("stablecoin-depeg", 1_700_000_005_000)
        ?.version,
      1
    );
    assert.equal(
      registry.getPolicyAtTimestamp("stablecoin-depeg", 1_700_000_015_000)
        ?.version,
      2
    );
    assert.equal(registry.getVersionHistory("stablecoin-depeg").length, 2);
  });
});
