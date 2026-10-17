import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IndependenceGraph } from "./independenceGraph.ts";

describe("IndependenceGraph (Issue #206)", () => {
  it("prevents colluding sources in one cluster from manufacturing quorum or outvoting an independent majority", () => {
    const graph = new IndependenceGraph();

    // 4 sybil wrappers sharing the same upstream / cluster
    for (let i = 1; i <= 4; i++) {
      graph.registerSource({
        sourceId: `sybil-wrapper-${i}`,
        operatorId: "attacker-org",
        upstreamOrigin: "https://upstream-a.example.com",
        declaredClusterId: "cluster-sybil",
      });
    }

    // 2 genuinely independent sources
    graph.registerSource({
      sourceId: "honest-noaa",
      operatorId: "noaa-gov",
      upstreamOrigin: "https://api.weather.gov",
      declaredClusterId: "cluster-noaa",
    });
    graph.registerSource({
      sourceId: "honest-ecmwf",
      operatorId: "ecmwf-eu",
      upstreamOrigin: "https://api.ecmwf.int",
      declaredClusterId: "cluster-ecmwf",
    });

    const t0 = 1_700_000_000_000;

    // 1. Only the 4 sybil sources submit -> 1 independent cluster -> quorum_unsatisfiable
    const sybilOnly = graph.evaluateClusterCorroboration(
      [1, 2, 3, 4].map((i) => ({
        sourceId: `sybil-wrapper-${i}`,
        value: 500,
        observedAtMs: t0,
        receivedAtMs: t0 + i * 50,
      })),
      { minIndependentClusters: 2, toleranceBandRatio: 0.05 }
    );
    assert.equal(sybilOnly.status, "quorum_unsatisfiable");
    assert.equal(sybilOnly.independentClusterCount, 1);
    assert.equal(sybilOnly.agreedValue, null);

    // 2. All 4 sybil sources report 500, while 2 independent honest clusters report 100 and 102
    // Naive source-count median of [100, 102, 500, 500, 500, 500] would be 500!
    // Cluster-weighted consensus gives 1 vote per cluster ([100, 102, 500]) -> median is 102, sybil cluster rejected as outlier, agreedValue = 101!
    const defended = graph.evaluateClusterCorroboration(
      [
        {
          sourceId: "sybil-wrapper-1",
          value: 500,
          observedAtMs: t0,
          receivedAtMs: t0 + 100,
        },
        {
          sourceId: "sybil-wrapper-2",
          value: 500,
          observedAtMs: t0,
          receivedAtMs: t0 + 150,
        },
        {
          sourceId: "sybil-wrapper-3",
          value: 500,
          observedAtMs: t0,
          receivedAtMs: t0 + 200,
        },
        {
          sourceId: "sybil-wrapper-4",
          value: 500,
          observedAtMs: t0,
          receivedAtMs: t0 + 250,
        },
        {
          sourceId: "honest-noaa",
          value: 100,
          observedAtMs: t0,
          receivedAtMs: t0 + 300,
        },
        {
          sourceId: "honest-ecmwf",
          value: 102,
          observedAtMs: t0,
          receivedAtMs: t0 + 400,
        },
      ],
      { minIndependentClusters: 2, toleranceBandRatio: 0.05 }
    );

    assert.equal(defended.status, "corroborated");
    assert.equal(defended.independentClusterCount, 3);
    assert.equal(defended.agreeingClusterIds.length, 2);
    assert.equal(defended.agreedValue, 101);
  });

  it("detects identical payload hashes across clusters and records auditable, reversible admin cluster overrides", () => {
    const graph = new IndependenceGraph();
    graph.registerSource({
      sourceId: "src-a",
      operatorId: "op-a",
      upstreamOrigin: "https://a.example.com",
      declaredClusterId: "cluster-a",
    });
    graph.registerSource({
      sourceId: "src-b",
      operatorId: "op-b",
      upstreamOrigin: "https://b.example.com",
      declaredClusterId: "cluster-b",
    });

    const t0 = 1_700_000_000_000;
    const clonedCheck = graph.evaluateClusterCorroboration(
      [
        {
          sourceId: "src-a",
          value: 200,
          observedAtMs: t0,
          receivedAtMs: t0 + 100,
          rawPayloadHash: "sha256:deadbeef",
        },
        {
          sourceId: "src-b",
          value: 200,
          observedAtMs: t0,
          receivedAtMs: t0 + 500,
          rawPayloadHash: "sha256:deadbeef",
        },
      ],
      { minIndependentClusters: 2, toleranceBandRatio: 0.05 }
    );

    // Identical rawPayloadHash collapses src-b into src-a's cluster -> only 1 independent cluster
    assert.equal(clonedCheck.status, "quorum_unsatisfiable");
    assert.equal(clonedCheck.correlationAlerts.length, 1);
    assert.equal(
      clonedCheck.correlationAlerts[0]?.type,
      "identical_payload_across_clusters"
    );

    // Admin override and revert audit trail
    const ovr = graph.overrideSourceCluster({
      sourceId: "src-b",
      newClusterId: "cluster:cluster-a",
      actorId: "admin-1",
      reason: "Confirmed shared upstream reseller",
      nowMs: t0,
    });
    assert.equal(graph.resolveClusterId("src-b").clusterId, "cluster:cluster-a");
    assert.equal(ovr.previousClusterId, "cluster:cluster-b");

    const reverted = graph.revertClusterOverride("src-b", t0 + 5_000);
    assert.equal(reverted, true);
    assert.equal(graph.resolveClusterId("src-b").clusterId, "cluster:cluster-b");
    assert.equal(graph.getAuditLog()[0]?.revertedAtMs, t0 + 5_000);
  });
});
