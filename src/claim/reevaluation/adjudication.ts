import type { FeedTrustState } from "../../oracle/regions/region-quorum";
import type { TriggerDirection } from "../trigger/trigger-stability";

/**
 * What ClaimService did with a policy on one scan:
 *  - held:    the trigger condition was met but the feed wasn't trusted, so payout was withheld
 *  - skipped: the trigger condition wasn't met (so nothing was paid)
 *  - settled: a payout went out on-chain
 */
export type AdjudicationOutcome = "held" | "skipped" | "settled";

/** One claim decision made while its feed was not in the "trusted" state. */
export interface AdjudicationRecord {
  /** Deterministic: `${policyId}:${decidedAt}`. */
  id: string;
  policyId: string;
  holder: string;
  coverageType: number;
  feedId: string;
  outcome: AdjudicationOutcome;
  trustState: FeedTrustState;
  decidedAt: number;
  /** Value the decision was based on. */
  readingValue: number;
  threshold: number;
  direction: TriggerDirection;
  /** Full payout for this policy, 1e7 base units. */
  coverageAmount: string;
  /** What was actually paid by this decision, 1e7 base units. */
  paid: string;
  /** Policy expiry, epoch ms. Readings after it never count. */
  expiresAt: number;
  settlementTxHash?: string;
  /** Set once a re-evaluation run has taken this record. */
  reevaluatedBy?: string;
}

/** Feed a policy's trigger reads. Mirrors ClaimService.fetchOracleData's routing. */
export function feedIdForPolicy(coverageType: number, triggerParams?: Record<string, unknown>): string {
  switch (coverageType) {
    case 0:
      return "usdc-usd";
    case 1:
      return "market-24h-change";
    case 2:
      return "liquidation-ratio";
    case 3:
      return "tvl-drop";
    case 4: {
      const flight = triggerParams?.flightNumber;
      return `flight-delay:${typeof flight === "string" ? flight : "UNKNOWN"}`;
    }
    default:
      return `coverage-${coverageType}`;
  }
}
