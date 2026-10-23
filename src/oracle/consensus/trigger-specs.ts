import { MetricId } from "../adapters/source-adapter";
import { TriggerDirection } from "./consensus-decision";

export interface TriggerSpec {
  coverageType: string;
  /** Live metric that drives this trigger, or null when no live source exists. */
  metric: MetricId | null;
  threshold: number;
  /** "below": triggers when value < threshold. "above": when value > threshold. */
  direction: TriggerDirection;
  /** Largest allowed max−min spread between sources before the decision is "conflicted". */
  maxSpread: number;
}

/**
 * Settlement triggers, keyed by the on-chain coverage type discriminant.
 * Thresholds match the informational readings in OracleService.
 *
 * LiquidationShield and FlightDelay have no live source yet (NEXUS Protocol
 * has no public feed; AviationStack needs a paid key). Their decisions are
 * always "insufficient", so they cannot settle automatically on mocked data.
 */
export const TRIGGER_SPECS: Readonly<Record<number, TriggerSpec>> = {
  0: { coverageType: "StablecoinDepeg", metric: "usdc.usd.price", threshold: 0.95, direction: "below", maxSpread: 0.02 },
  1: { coverageType: "MarketCrash", metric: "xlm.usd.change_24h_pct", threshold: -30, direction: "below", maxSpread: 5 },
  2: { coverageType: "LiquidationShield", metric: null, threshold: 0.85, direction: "below", maxSpread: 0 },
  3: { coverageType: "SmartContractRisk", metric: "protocol.tvl.change_24h_pct", threshold: -50, direction: "below", maxSpread: 10 },
  4: { coverageType: "FlightDelay", metric: null, threshold: 120, direction: "above", maxSpread: 0 },
};

export function isPastThreshold(value: number, spec: Pick<TriggerSpec, "threshold" | "direction">): boolean {
  return spec.direction === "below" ? value < spec.threshold : value > spec.threshold;
}
