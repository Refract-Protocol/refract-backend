import { test } from "node:test";
import assert from "node:assert/strict";
import { VersionedQuorumPolicyStore, type QuorumPolicyParameters } from "./versionedQuorumPolicyStore.ts";

test("VersionedQuorumPolicyStore deduplicates identical policy snapshots by SHA-256 and marks legacy decisions as unversioned", () => {
  const store = new VersionedQuorumPolicyStore();

  const baseParams: QuorumPolicyParameters = {
    feedId: "XLM_USD",
    minIndependentSources: 3,
    maxRelativeSpreadBps: 50,
    outlierDeviationMultiplier: 2.5,
    freshnessWindowMs: 60_000,
    aggregationMethod: "weighted_median",
    trustMode: "production",
    sourceWeights: { coingecko: 1.0, binance: 1.0, kraken: 1.0 },
  };

  const snap1 = store.getOrCreateSnapshot(baseParams, 1_000);
  // Identical config with different key order reuses the same content-addressed snapshot
  const snap2 = store.getOrCreateSnapshot(
    {
      ...baseParams,
      sourceWeights: { kraken: 1.0, coingecko: 1.0, binance: 1.0 },
    },
    2_000
  );
  assert.equal(snap1.policyHash, snap2.policyHash);
  assert.equal(store.getSnapshotCount(), 1);

  // Changing minIndependentSources creates a new immutable snapshot
  const snap3 = store.getOrCreateSnapshot(
    { ...baseParams, minIndependentSources: 4 },
    3_000
  );
  assert.notEqual(snap1.policyHash, snap3.policyHash);
  assert.equal(store.getSnapshotCount(), 2);

  store.linkDecisionToPolicy("dec-v1", snap1.policyHash);
  store.linkDecisionToPolicy("dec-legacy", null);

  // Historical decision still resolves to snap1 (minIndependentSources=3) even after snap3 is created
  const resolvedV1 = store.resolveDecisionPolicy("dec-v1");
  assert.equal(resolvedV1.policyHash, snap1.policyHash);
  assert.equal(resolvedV1.snapshot?.parameters.minIndependentSources, 3);

  const resolvedLegacy = store.resolveDecisionPolicy("dec-legacy");
  assert.equal(resolvedLegacy.policyHash, "unversioned");
  assert.equal(resolvedLegacy.snapshot, null);
});
