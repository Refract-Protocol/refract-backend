/**
 * Corroboration: turns independent provider readings for one feed into a
 * consensus decision.
 *
 * Steps:
 *  1. Keep each provider's latest reading inside the window. A provider
 *     never counts twice.
 *  2. Wait until at least `minProviders` distinct providers have reported.
 *  3. Take the median, and flag readings further from it than the tolerance
 *     as outliers. The tolerance is max(|median| × maxDeviationRatio,
 *     absoluteTolerance). The absolute floor covers feeds whose value can be
 *     near zero, such as percentage changes.
 *  4. Accept when the readings that agree still meet `minProviders`. The
 *     consensus value is the median of the agreeing readings.
 *
 * Pure function, no I/O, so the sandbox and a future production path can
 * share it.
 */

export interface CorroborationPolicy {
  minProviders: number;
  maxDeviationRatio: number;
  absoluteTolerance: number;
  windowMs: number;
}

export interface CorroborationInput {
  submissionId: string;
  providerId: string;
  value: number;
  observedAtMs: number;
}

export type CorroborationOutcome =
  | {
      status: "pending";
      feed: string;
      providers: number;
      required: number;
    }
  | {
      status: "accepted" | "rejected";
      feed: string;
      value: number | null;
      median: number;
      tolerance: number;
      agreeing: CorroborationInput[];
      outliers: CorroborationInput[];
      reason?: "insufficient_agreement";
    };

export const DEFAULT_CORROBORATION_POLICY: CorroborationPolicy = {
  minProviders: 3,
  maxDeviationRatio: 0.02,
  absoluteTolerance: 0,
  windowMs: 5 * 60_000,
};

export function median(values: number[]): number {
  if (values.length === 0) throw new Error("median of empty set");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function corroborate(
  feed: string,
  readings: CorroborationInput[],
  policy: CorroborationPolicy,
  nowMs: number,
): CorroborationOutcome {
  const windowStart = nowMs - policy.windowMs;
  const latestByProvider = new Map<string, CorroborationInput>();
  for (const reading of readings) {
    if (reading.observedAtMs < windowStart) continue;
    const prev = latestByProvider.get(reading.providerId);
    if (!prev || reading.observedAtMs > prev.observedAtMs) {
      latestByProvider.set(reading.providerId, reading);
    }
  }

  const current = [...latestByProvider.values()];
  if (current.length < policy.minProviders) {
    return {
      status: "pending",
      feed,
      providers: current.length,
      required: policy.minProviders,
    };
  }

  const mid = median(current.map((r) => r.value));
  const tolerance = Math.max(Math.abs(mid) * policy.maxDeviationRatio, policy.absoluteTolerance);
  const agreeing = current.filter((r) => Math.abs(r.value - mid) <= tolerance);
  const outliers = current.filter((r) => Math.abs(r.value - mid) > tolerance);

  if (agreeing.length < policy.minProviders) {
    return {
      status: "rejected",
      feed,
      value: null,
      median: mid,
      tolerance,
      agreeing,
      outliers,
      reason: "insufficient_agreement",
    };
  }

  return {
    status: "accepted",
    feed,
    value: median(agreeing.map((r) => r.value)),
    median: mid,
    tolerance,
    agreeing,
    outliers,
  };
}
