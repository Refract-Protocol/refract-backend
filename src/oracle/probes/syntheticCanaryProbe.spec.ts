import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SyntheticCanaryProbeRunner,
  type CanaryProbeSchemaSpec,
} from "./syntheticCanaryProbe.ts";

const XLM_SCHEMA: CanaryProbeSchemaSpec = {
  expectedUnit: "USD",
  minPlausibleValue: 0.01,
  maxPlausibleValue: 10,
  allowedFields: ["value", "unit", "observedAtMs"],
};

test("SyntheticCanaryProbeRunner detects schema drift, frozen payloads, and excludes canary probes from consensus", async () => {
  const runner = new SyntheticCanaryProbeRunner({
    quarantineFailureThreshold: 3,
    maxIdenticalPayloads: 3,
  });

  // 1. Valid probe reading is marked probe=true and excluded from consensus
  const validProbe = await runner.runCanaryProbe({
    sourceId: "horizon",
    feedId: "XLM-USD",
    schema: XLM_SCHEMA,
    fetchRawPayload: async () => ({
      value: 0.12,
      unit: "USD",
      observedAtMs: 1_000,
    }),
  });
  assert.equal(validProbe.ok, true);
  assert.equal(validProbe.reading?.probe, true);

  const liveReading = {
    sourceId: "horizon",
    feedId: "XLM-USD",
    value: 0.121,
    unit: "USD",
    observedAtMs: 1_050,
    probe: false,
  };
  const eligible = runner.filterConsensusEligibleReadings([
    validProbe.reading!,
    liveReading,
  ]);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].probe, false);

  // 2. Frozen payload detection after 3 identical payloads
  await runner.runCanaryProbe({
    sourceId: "horizon",
    feedId: "XLM-USD",
    schema: XLM_SCHEMA,
    fetchRawPayload: async () => ({
      value: 0.12,
      unit: "USD",
      observedAtMs: 1_000,
    }),
  });
  const frozenProbe = await runner.runCanaryProbe({
    sourceId: "horizon",
    feedId: "XLM-USD",
    schema: XLM_SCHEMA,
    fetchRawPayload: async () => ({
      value: 0.12,
      unit: "USD",
      observedAtMs: 1_000,
    }),
  });
  assert.equal(frozenProbe.ok, false);
  assert.equal(frozenProbe.failureReason, "FROZEN_PAYLOAD");
  assert.equal(runner.getSourceMetrics("horizon")?.frozenPayloadDetections, 1);
});

test("SyntheticCanaryProbeRunner quarantines a source after three consecutive probe failures", async () => {
  const runner = new SyntheticCanaryProbeRunner({
    quarantineFailureThreshold: 3,
  });

  // Failure 1: unknown field (schema drift)
  const f1 = await runner.runCanaryProbe({
    sourceId: "coingecko",
    feedId: "XLM-USD",
    schema: XLM_SCHEMA,
    fetchRawPayload: async () => ({
      value: 0.11,
      unit: "USD",
      observedAtMs: 2_000,
      unexpectedExtraField: true,
    }),
  });
  assert.equal(f1.failureReason, "SCHEMA_DRIFT");
  assert.equal(f1.quarantinedTriggered, false);

  // Failure 2: unit/scale drift (price returned in cents instead of USD)
  const f2 = await runner.runCanaryProbe({
    sourceId: "coingecko",
    feedId: "XLM-USD",
    schema: XLM_SCHEMA,
    fetchRawPayload: async () => ({
      value: 11.5,
      unit: "USD",
      observedAtMs: 2_100,
    }),
  });
  assert.equal(f2.failureReason, "UNIT_SCALE_DRIFT");
  assert.equal(f2.quarantinedTriggered, false);

  // Failure 3: liveness failure -> triggers quarantine
  const f3 = await runner.runCanaryProbe({
    sourceId: "coingecko",
    feedId: "XLM-USD",
    schema: XLM_SCHEMA,
    fetchRawPayload: async () => {
      throw new Error("Connection reset");
    },
  });
  assert.equal(f3.failureReason, "LIVENESS_ERROR");
  assert.equal(f3.quarantinedTriggered, true);
  assert.equal(runner.getSourceMetrics("coingecko")?.quarantined, true);
});
