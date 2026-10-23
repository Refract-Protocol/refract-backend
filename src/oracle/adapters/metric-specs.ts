import { MetricId } from "./source-adapter";

/**
 * Canonical definition of each metric: its unit, the precision every source
 * is rounded to, plausible bounds, and how old a value may be before it is
 * rejected as stale. Values outside the bounds are treated as malformed or
 * manipulated responses, not as real market moves.
 */
export interface MetricSpec {
  unit: "usd" | "percent" | "ledger";
  /** Decimal places every source's value is rounded to. */
  decimals: number;
  min: number;
  max: number;
  /** Maximum allowed age (ms) of `observedAt` relative to now. */
  maxAgeMs: number;
}

export const METRIC_SPECS: Readonly<Record<MetricId, MetricSpec>> = {
  "usdc.usd.price": { unit: "usd", decimals: 6, min: 0, max: 2, maxAgeMs: 10 * 60_000 },
  "xlm.usd.change_24h_pct": { unit: "percent", decimals: 4, min: -100, max: 1_000, maxAgeMs: 10 * 60_000 },
  "protocol.tvl.change_24h_pct": { unit: "percent", decimals: 4, min: -100, max: 1_000, maxAgeMs: 6 * 60 * 60_000 },
  "stellar.ledger.latest": { unit: "ledger", decimals: 0, min: 1, max: Number.MAX_SAFE_INTEGER, maxAgeMs: 2 * 60_000 },
};

/** Clock skew tolerated for upstream timestamps that are slightly in the future. */
export const MAX_FUTURE_SKEW_MS = 30_000;

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  // Normalise -0 so canonical values compare and serialise identically.
  return rounded === 0 ? 0 : rounded;
}
