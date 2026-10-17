import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeAndValidateNumericReading,
  evaluateWeightedQuorumConsensus,
  runPropertyWithShrinking,
  SeededRandom,
  type WeightedSourceInput,
} from "./consensusPropertyFuzzer.ts";

function generateRandomReadings(rng: SeededRandom): WeightedSourceInput[] {
  const count = rng.nextInt(3, 9);
  const items: WeightedSourceInput[] = [];
  for (let i = 0; i < count; i++) {
    items.push({
      sourceId: `src-${i}`,
      value: Number((0.5 + rng.nextFloat() * 100).toFixed(6)),
      weight: Number((0.1 + rng.nextFloat() * 5).toFixed(4)),
    });
  }
  return items;
}

test("8 consensus/quorum properties hold across seeded adversarial inputs", () => {
  // Property 1: Permutation invariance
  const p1 = runPropertyWithShrinking({
    seed: 101,
    iterations: 100,
    generate: generateRandomReadings,
    predicate: (sample) => {
      const rng = new SeededRandom(999);
      const shuffled = rng.shuffle(sample);
      const a = evaluateWeightedQuorumConsensus(sample, 3);
      const b = evaluateWeightedQuorumConsensus(shuffled, 3);
      return (
        a.quorumReached === b.quorumReached && a.medianValue === b.medianValue
      );
    },
  });
  assert.equal(p1.passed, true);

  // Property 2: Unweighted median reference parity
  const p2 = runPropertyWithShrinking({
    seed: 202,
    iterations: 100,
    generate: (rng) =>
      generateRandomReadings(rng).map((r) => ({ ...r, weight: 1 })),
    predicate: (sample) => {
      const sorted = [...sample].map((s) => s.value).sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const refMedian = Number(
        (sorted.length % 2 === 0
          ? (sorted[mid - 1] + sorted[mid]) / 2
          : sorted[mid]
        ).toFixed(8)
      );
      const res = evaluateWeightedQuorumConsensus(sample, 1);
      return res.medianValue === refMedian;
    },
  });
  assert.equal(p2.passed, true);

  // Property 3: Monotonicity of quorum satisfaction as agreeing sources are added
  const p3 = runPropertyWithShrinking({
    seed: 303,
    iterations: 100,
    generate: generateRandomReadings,
    predicate: (sample) => {
      const before = evaluateWeightedQuorumConsensus(sample, 3);
      const extended = [
        ...sample,
        { sourceId: "extra-agreeing-src", value: sample[0].value, weight: 1 },
      ];
      const after = evaluateWeightedQuorumConsensus(extended, 3);
      return !before.quorumReached || after.quorumReached;
    },
  });
  assert.equal(p3.passed, true);

  // Property 4: Weight normalization and positive scalar invariance
  const p4 = runPropertyWithShrinking({
    seed: 404,
    iterations: 100,
    generate: generateRandomReadings,
    predicate: (sample) => {
      const base = evaluateWeightedQuorumConsensus(sample, 3);
      const scaled = sample.map((s) => ({ ...s, weight: s.weight * 17.5 }));
      const after = evaluateWeightedQuorumConsensus(scaled, 3);
      return base.medianValue === after.medianValue;
    },
  });
  assert.equal(p4.passed, true);

  // Property 5: Determinism for identical inputs
  const p5 = runPropertyWithShrinking({
    seed: 505,
    iterations: 100,
    generate: generateRandomReadings,
    predicate: (sample) => {
      const first = JSON.stringify(evaluateWeightedQuorumConsensus(sample, 3));
      const second = JSON.stringify(evaluateWeightedQuorumConsensus(sample, 3));
      return first === second;
    },
  });
  assert.equal(p5.passed, true);

  // Property 6: Bounded range invariant (min <= median <= max)
  const p6 = runPropertyWithShrinking({
    seed: 606,
    iterations: 100,
    generate: generateRandomReadings,
    predicate: (sample) => {
      const res = evaluateWeightedQuorumConsensus(sample, 2);
      const min = Math.min(...sample.map((s) => s.value));
      const max = Math.max(...sample.map((s) => s.value));
      return (
        res.medianValue !== null &&
        res.medianValue >= min - 1e-8 &&
        res.medianValue <= max + 1e-8
      );
    },
  });
  assert.equal(p6.passed, true);

  // Property 7: Zero-variance exactness
  const p7 = runPropertyWithShrinking({
    seed: 707,
    iterations: 50,
    generate: (rng) => {
      const constantVal = Number((1 + rng.nextFloat() * 10).toFixed(6));
      return generateRandomReadings(rng).map((s) => ({
        ...s,
        value: constantVal,
      }));
    },
    predicate: (sample) => {
      const res = evaluateWeightedQuorumConsensus(sample, 3);
      return res.medianValue === sample[0].value;
    },
  });
  assert.equal(p7.passed, true);

  // Property 8: Duplicate readings from the same sourceId cannot self-satisfy quorum
  const dupInputs: WeightedSourceInput[] = [
    { sourceId: "src-1", value: 1.0, weight: 1 },
    { sourceId: "src-1", value: 1.0, weight: 1 },
    { sourceId: "src-1", value: 1.0, weight: 1 },
  ];
  const dupDecision = evaluateWeightedQuorumConsensus(dupInputs, 2);
  assert.equal(dupDecision.quorumReached, false);
  assert.equal(dupDecision.agreeingSourceCount, 1);
});

test("3 fuzz targets reject malformed/extreme encodings and shrink counterexamples with replayable seeds", () => {
  // Fuzz Target 1: Malformed and non-finite inputs
  const malformedInputs: unknown[] = [
    NaN,
    Infinity,
    -Infinity,
    "",
    "   ",
    "0x1234",
    "1.2.3",
    "NaN",
    null,
    undefined,
    {},
  ];
  for (const raw of malformedInputs) {
    assert.equal(decodeAndValidateNumericReading(raw).valid, false);
  }

  // Fuzz Target 2: Out-of-bounds extreme numeric readings
  const extremeInputs: unknown[] = [0, -0.0001, -999999, 1e15, "0", "-42.5"];
  for (const raw of extremeInputs) {
    assert.equal(decodeAndValidateNumericReading(raw).valid, false);
  }

  // Fuzz Target 3: Counterexample shrinker produces minimized failing slice + seed
  const intentionalFailure = runPropertyWithShrinking({
    seed: 1337,
    iterations: 20,
    generate: () => [10, 20, 30, 40, 50],
    predicate: (arr) => arr.length < 2, // fails as soon as length >= 2
  });
  assert.equal(intentionalFailure.passed, false);
  assert.equal(intentionalFailure.seed, 1337);
  assert.deepEqual(intentionalFailure.counterexample, [10, 20]);
});
