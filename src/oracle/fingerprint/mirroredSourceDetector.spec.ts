import { test } from "node:test";
import assert from "node:assert/strict";
import { MirroredSourceDetector, type SourceReadingSample } from "./mirroredSourceDetector.ts";

test("MirroredSourceDetector flags cloned/mirrored sources and caps independence weight", () => {
  const detector = new MirroredSourceDetector({
    minSamples: 3,
    exactMatchThreshold: 0.9,
    nearMatchValueToleranceBps: 5,
    mirroredIndependenceWeightCap: 0.1,
  });

  const samples: SourceReadingSample[] = [];
  for (let w = 1; w <= 4; w++) {
    samples.push({
      sourceId: "provider-alpha",
      windowTimestampMs: w * 60_000,
      normalizedValue: 100 + w,
      rawPayload: { station: "S1", temp: 100 + w, requestId: `req-a-${w}`, ts: w * 60_000 },
    });
    samples.push({
      sourceId: "provider-beta-clone",
      windowTimestampMs: w * 60_000,
      normalizedValue: 100 + w,
      rawPayload: { temp: 100 + w, station: "S1", requestId: `req-b-${w}`, ts: w * 60_000 + 15 },
    });
    samples.push({
      sourceId: "provider-gamma-independent",
      windowTimestampMs: w * 60_000,
      normalizedValue: 100 + w * 3,
      rawPayload: { station: "S2", temp: 100 + w * 3, requestId: `req-c-${w}` },
    });
  }

  const result = detector.evaluatePairs(samples);
  const clonePair = result.pairs.find(
    (p) => p.sourceA === "provider-alpha" && p.sourceB === "provider-beta-clone"
  );
  assert.ok(clonePair);
  assert.equal(clonePair.isMirrored, true);
  assert.equal(clonePair.exactPayloadMatchRatio, 1);
  assert.equal(result.effectiveIndependenceWeights["provider-beta-clone"], 0.1);
  assert.equal(result.effectiveIndependenceWeights["provider-gamma-independent"], 1.0);
});
