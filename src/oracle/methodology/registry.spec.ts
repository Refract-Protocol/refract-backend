import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_OPAQUE_INDEPENDENCE_WEIGHT_BPS,
  ProviderMethodologyRegistry,
} from "./registry.ts";

test("Issue #294: blocks activation without approved methodology, caps weight for opaque methodology, and preserves immutable versions for historical decisions", () => {
  const registry = new ProviderMethodologyRegistry();
  const now = 1_750_000_000_000;

  // Missing methodology blocks activation
  assert.throws(
    () =>
      registry.activateSource({
        sourceId: "coingecko",
        requestedIndependenceWeightBps: 10_000,
        nowMs: now,
      }),
    /no methodology record registered/
  );

  // Unapproved methodology (explicitSignOff: false) blocks activation
  registry.registerMethodology({
    sourceId: "coingecko",
    derivationDescription: "VWAP across 12 tier-1 spot exchanges",
    samplingUniverse: ["binance", "coinbase", "kraken"],
    revisionPolicy: "immutable_final",
    expectedLatencyMs: 2_000,
    knownFailureModes: ["exchange_api_rate_limit"],
    publishableMethodology: true,
    explicitSignOff: false,
    createdAtMs: now,
  });

  assert.throws(
    () =>
      registry.activateSource({
        sourceId: "coingecko",
        requestedIndependenceWeightBps: 10_000,
        nowMs: now,
      }),
    /lacks explicit approval sign-off/
  );

  // Register approved v2 methodology for coingecko
  const cgV2 = registry.registerMethodology({
    sourceId: "coingecko",
    derivationDescription: "VWAP across 15 tier-1 spot exchanges with outlier trimming",
    samplingUniverse: ["binance", "coinbase", "kraken", "bitstamp"],
    revisionPolicy: "immutable_final",
    expectedLatencyMs: 1_500,
    knownFailureModes: ["exchange_api_rate_limit"],
    publishableMethodology: true,
    approvedBy: "risk_committee",
    explicitSignOff: true,
    createdAtMs: now + 1_000,
  });
  assert.equal(cgV2.version, 2);

  const cgActive = registry.activateSource({
    sourceId: "coingecko",
    requestedIndependenceWeightBps: 10_000,
    nowMs: now + 2_000,
  });
  assert.equal(cgActive.pinnedMethodologyVersion, 2);
  assert.equal(cgActive.effectiveIndependenceWeightBps, 10_000);

  // Opaque source (publishableMethodology: false) is capped at MAX_OPAQUE_INDEPENDENCE_WEIGHT_BPS (5000)
  registry.registerMethodology({
    sourceId: "proprietary_vendor",
    derivationDescription: "Proprietary black-box risk index",
    samplingUniverse: ["undisclosed"],
    revisionPolicy: "late_correction_allowed",
    expectedLatencyMs: 5_000,
    knownFailureModes: ["vendor_outage"],
    publishableMethodology: false,
    approvedBy: "risk_committee",
    explicitSignOff: true,
    createdAtMs: now,
  });

  const opaqueActive = registry.activateSource({
    sourceId: "proprietary_vendor",
    requestedIndependenceWeightBps: 10_000,
    nowMs: now + 2_000,
  });
  assert.equal(
    opaqueActive.effectiveIndependenceWeightBps,
    MAX_OPAQUE_INDEPENDENCE_WEIGHT_BPS
  );

  // Capture decision references and verify historical v1 vs v2 immutability
  const decisionRefs = registry.captureDecisionMethodologyReferences([
    "coingecko",
    "proprietary_vendor",
  ]);
  assert.deepEqual(decisionRefs, {
    coingecko: 2,
    proprietary_vendor: 1,
  });

  // Register v3 for coingecko later; historical decision still resolves v2 semantics!
  registry.registerMethodology({
    sourceId: "coingecko",
    derivationDescription: "v3 updated methodology with DEX pools",
    samplingUniverse: ["binance", "uniswap_v3"],
    revisionPolicy: "immutable_final",
    expectedLatencyMs: 1_000,
    knownFailureModes: ["rpc_lag"],
    publishableMethodology: true,
    approvedBy: "risk_committee",
    explicitSignOff: true,
    createdAtMs: now + 100_000,
  });

  const resolvedHistorical = registry.getMethodologyVersion(
    "coingecko",
    decisionRefs.coingecko
  );
  assert.equal(
    resolvedHistorical.derivationDescription,
    "VWAP across 15 tier-1 spot exchanges with outlier trimming"
  );
});

test("Issue #294: detects behavioral drift against declared methodology and renders public provenance surface", () => {
  const registry = new ProviderMethodologyRegistry();
  const now = 1_750_000_000_000;

  registry.registerMethodology({
    sourceId: "defillama",
    derivationDescription: "On-chain adapter TVL summation",
    samplingUniverse: ["ethereum", "stellar", "arbitrum"],
    revisionPolicy: "immutable_final",
    expectedLatencyMs: 2_000,
    knownFailureModes: ["archive_node_lag"],
    publishableMethodology: true,
    approvedBy: "risk_committee",
    explicitSignOff: true,
    createdAtMs: now,
    reAttestationIntervalMs: 60_000,
  });
  registry.activateSource({
    sourceId: "defillama",
    requestedIndependenceWeightBps: 9_000,
    nowMs: now,
  });

  const drift = registry.evaluateBehavioralDrift({
    sourceId: "defillama",
    observedP95LatencyMs: 6_000, // > 2 * 2000ms
    observedLateCorrection: true, // violates immutable_final
    nowMs: now + 120_000, // > 60_000ms re-attestation interval
  });
  assert.equal(drift.reAttestationExpired, true);
  assert.equal(drift.latencyDriftDetected, true);
  assert.equal(drift.unauthorizedRevisionDetected, true);
  assert.equal(drift.flags.length, 3);

  const surface = registry.renderPublicProvenanceSurface(["defillama"]);
  assert.equal(surface[0].active, true);
  assert.equal(surface[0].methodologyVersion, 1);
  assert.equal(surface[0].effectiveIndependenceWeightBps, 9_000);
});
