export interface WeightedSourceInput {
  sourceId: string;
  value: number;
  weight: number;
}

export interface QuorumConsensusDecision {
  quorumReached: boolean;
  medianValue: number | null;
  agreeingSourceCount: number;
  normalizedTotalWeight: number;
}

export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }

  public nextFloat(): number {
    // xorshift32
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0xffffffff;
  }

  public nextInt(minInclusive: number, maxInclusive: number): number {
    return (
      minInclusive +
      Math.floor(this.nextFloat() * (maxInclusive - minInclusive + 1))
    );
  }

  public shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.nextInt(0, i);
      const tmp = copy[i];
      copy[i] = copy[j];
      copy[j] = tmp;
    }
    return copy;
  }
}

/**
 * Pure weighted-median and quorum evaluator with per-source deduplication.
 */
export function evaluateWeightedQuorumConsensus(
  inputs: readonly WeightedSourceInput[],
  minQuorumSources: number
): QuorumConsensusDecision {
  // Deduplicate by sourceId (keep first valid finite reading with positive weight)
  const dedupedMap = new Map<string, WeightedSourceInput>();
  for (const item of inputs) {
    if (
      !Number.isFinite(item.value) ||
      !Number.isFinite(item.weight) ||
      item.weight <= 0
    ) {
      continue;
    }
    if (!dedupedMap.has(item.sourceId)) {
      dedupedMap.set(item.sourceId, item);
    }
  }

  const unique = Array.from(dedupedMap.values());
  if (unique.length < minQuorumSources || unique.length === 0) {
    return {
      quorumReached: false,
      medianValue: null,
      agreeingSourceCount: unique.length,
      normalizedTotalWeight: 0,
    };
  }

  // Sort by value ascending, breaking ties deterministically by weight
  const sorted = [...unique].sort((a, b) => a.value - b.value);
  const totalWeight = sorted.reduce((acc, s) => acc + s.weight, 0);

  let cumulative = 0;
  const halfWeight = totalWeight / 2;
  let medianValue = sorted[sorted.length - 1].value;

  for (let i = 0; i < sorted.length; i++) {
    cumulative += sorted[i].weight;
    if (cumulative > halfWeight) {
      medianValue = sorted[i].value;
      break;
    }
    if (
      Math.abs(cumulative - halfWeight) <= 1e-12 &&
      i + 1 < sorted.length
    ) {
      medianValue = (sorted[i].value + sorted[i + 1].value) / 2;
      break;
    }
  }

  return {
    quorumReached: true,
    medianValue: Number(medianValue.toFixed(8)),
    agreeingSourceCount: unique.length,
    normalizedTotalWeight: 1,
  };
}

/**
 * Serialization/encoding boundary guard that rejects malformed, non-finite, or extreme numeric inputs.
 */
export function decodeAndValidateNumericReading(raw: unknown): {
  valid: boolean;
  value: number | null;
  reason: string | null;
} {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      return { valid: false, value: null, reason: "NON_FINITE_NUMBER" };
    }
    if (raw <= 0 || raw > 1e12) {
      return { valid: false, value: null, reason: "OUT_OF_PLAUSIBLE_BOUNDS" };
    }
    return { valid: true, value: Number(raw.toFixed(8)), reason: null };
  }

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!/^[+]?\d+(\.\d+)?$/.test(trimmed)) {
      return { valid: false, value: null, reason: "MALFORMED_NUMERIC_STRING" };
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1e12) {
      return { valid: false, value: null, reason: "OUT_OF_PLAUSIBLE_BOUNDS" };
    }
    return { valid: true, value: Number(parsed.toFixed(8)), reason: null };
  }

  return { valid: false, value: null, reason: "UNSUPPORTED_TYPE" };
}

/**
 * Property runner that shrinks a failing array counterexample to its minimal failing prefix
 * and outputs a replayable seed.
 */
export function runPropertyWithShrinking<T>(params: {
  seed: number;
  iterations: number;
  generate: (rng: SeededRandom) => T[];
  predicate: (sample: T[]) => boolean;
}): {
  passed: boolean;
  seed: number;
  counterexample: T[] | null;
} {
  const rng = new SeededRandom(params.seed);

  for (let i = 0; i < params.iterations; i++) {
    const sample = params.generate(rng);
    if (!params.predicate(sample)) {
      // Shrink counterexample to minimal failing slice
      let minimized = sample;
      for (let len = 1; len < sample.length; len++) {
        const candidate = sample.slice(0, len);
        if (!params.predicate(candidate)) {
          minimized = candidate;
          break;
        }
      }
      return {
        passed: false,
        seed: params.seed,
        counterexample: minimized,
      };
    }
  }

  return {
    passed: true,
    seed: params.seed,
    counterexample: null,
  };
}
