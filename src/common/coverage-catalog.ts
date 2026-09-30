/**
 * Single source of truth for the five coverage products offered by Refract.
 *
 * Both QuoteService (GET /api/v1/quotes/coverage-types) and PolicyService
 * (GET /api/v1/policies/types) project their responses from this catalog, so
 * a product change updates both automatically.
 *
 * Reconciliation decisions (issue #59):
 * - riskLevel: policy's lowercase values win ("medium", "high", "critical",
 *   "low") — quote's "Low"/"Medium" casing was inconsistent with the rest of
 *   the catalog and with policy's client-facing output.
 * - riskMultiplier: both files agreed (1.0, 1.5, 2.0, 3.0, 0.8) — kept as-is.
 * - maxDuration: quote-only field, kept (policy never enforced a per-type
 *   duration cap).
 * - maxCoverage / baseRatePct: policy-only fields, kept (quote never enforced
 *   a per-type coverage cap).
 * - trigger: policy's trigger text wins where the two disagreed; quote's
 *   trigger text was a shorter paraphrase of the same condition.
 * - defaultTriggerThreshold: policy's TRIGGER_THRESHOLDS, in the units
 *   process_claim() compares against (see pool/src/lib.rs): bps for
 *   StablecoinDepeg/MarketCrash, minutes for FlightDelay.
 *   LiquidationShield/SmartContractRisk trigger on `oracle_value > 0` and
 *   never read trigger_threshold, so its value there is inert — kept
 *   non-zero only for consistency with the other entries.
 */
export type CoverageType =
  | "StablecoinDepeg"
  | "MarketCrash"
  | "LiquidationShield"
  | "SmartContractRisk"
  | "FlightDelay";

export interface CoverageProduct {
  /** Canonical string identifier, matching the on-chain enum variant name. */
  id: CoverageType;
  /** Numeric on-chain index, matching pool/src/lib.rs's CoverageType order. */
  onChainIndex: number;
  /** Human-readable display name. */
  name: string;
  description: string;
  trigger: string;
  riskLevel: string;
  riskMultiplier: number;
  baseRatePct: number;
  maxCoverage: number;
  maxDuration: number;
  icon: string;
  defaultTriggerThreshold: number;
}

export const COVERAGE_CATALOG = {
  StablecoinDepeg: {
    id: "StablecoinDepeg",
    onChainIndex: 0,
    name: "Stablecoin Depeg",
    description: "Pays out if a major stablecoin depegs below $0.95",
    trigger: "USDC price < $0.95 for 15+ minutes",
    riskLevel: "medium",
    riskMultiplier: 1.0,
    baseRatePct: 3.0,
    maxCoverage: 100_000,
    maxDuration: 30,
    icon: "🪙",
    defaultTriggerThreshold: 500,
  },
  MarketCrash: {
    id: "MarketCrash",
    onChainIndex: 1,
    name: "Market Crash",
    description: "Covers catastrophic market downturns exceeding 30% in 24h",
    trigger: "Market index 24h return < -30%",
    riskLevel: "high",
    riskMultiplier: 1.5,
    baseRatePct: 4.5,
    maxCoverage: 50_000,
    maxDuration: 60,
    icon: "📉",
    defaultTriggerThreshold: 3000,
  },
  LiquidationShield: {
    id: "LiquidationShield",
    onChainIndex: 2,
    name: "Liquidation Shield",
    description: "Pays out if your DeFi position gets liquidated",
    trigger: "Collateral ratio drops below maintenance threshold",
    riskLevel: "high",
    riskMultiplier: 2.0,
    baseRatePct: 6.0,
    maxCoverage: 200_000,
    maxDuration: 90,
    icon: "🛡️",
    defaultTriggerThreshold: 500,
  },
  SmartContractRisk: {
    id: "SmartContractRisk",
    onChainIndex: 3,
    name: "Smart Contract Risk",
    description: "Protection against smart contract exploits and hacks",
    trigger: "Covered protocol TVL drops >50% in <1 hour",
    riskLevel: "critical",
    riskMultiplier: 3.0,
    baseRatePct: 9.0,
    maxCoverage: 500_000,
    maxDuration: 180,
    icon: "🔐",
    defaultTriggerThreshold: 500,
  },
  FlightDelay: {
    id: "FlightDelay",
    onChainIndex: 4,
    name: "Flight Delay",
    description: "Automatic payout for flight delays over 2 hours",
    trigger: "Flight delayed > 120 minutes per AviationStack data",
    riskLevel: "low",
    riskMultiplier: 0.8,
    baseRatePct: 2.4,
    maxCoverage: 2_000,
    maxDuration: 7,
    icon: "✈️",
    defaultTriggerThreshold: 120,
  },
} as const satisfies Record<CoverageType, CoverageProduct>;

/** List form of the catalog, in on-chain index order. */
export const COVERAGE_PRODUCTS: readonly CoverageProduct[] = Object.values(COVERAGE_CATALOG);

/**
 * Looks up a product by its numeric on-chain index. Returns undefined for
 * out-of-range indices so callers can raise their own domain error.
 */
export function coverageProductByIndex(index: number): CoverageProduct | undefined {
  return COVERAGE_PRODUCTS.find((product) => product.onChainIndex === index);
}
