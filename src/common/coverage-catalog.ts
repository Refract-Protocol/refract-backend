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
 * - maxPoolExposurePct: per-coverage-type aggregate exposure cap (issue #134),
 *   expressed as a percentage of the pool's locked capital. Enforced at
 *   buy() time against the sum of currently-active coverage in that type so
 *   the pool cannot over-concentrate in a single risk category. Distinct from
 *   the per-policy maxCoverage cap and the pool-global on-chain bounds.
 *
 * Staged rollout (issue #131):
 * - Every product carries a `status` of `draft` or `live`. Newly staged
 *   products start as `draft` and are only visible to admins via the preview
 *   endpoint; they become publicly quotable/buyable only after an explicit
 *   publish transition. Public catalog reads (QuoteService, PolicyService)
 *   must filter to `live` products so a draft is never accidentally live.
 * - Each publish transition records an approval record (who drafted, who
 *   published, when) so the governance step is auditable.

 */
export type CoverageType =
  | "StablecoinDepeg"
  | "MarketCrash"
  | "LiquidationShield"
  | "SmartContractRisk"
  | "FlightDelay";

/** Lifecycle state of a coverage product in the staged rollout workflow. */
export type CoverageStatus = "draft" | "live";

/**
 * Auditable record of a coverage-type publish event. Captures who staged the
 * draft and who performed the distinctly-authorized publish action, plus the
 * timestamps of each transition.
 */
export interface CoverageApprovalRecord {
  /** Admin actor that created the coverage type in `draft` state. */
  draftedBy: string;
  /** When the draft was created. */
  draftedAt: string;
  /** Admin actor that transitioned the draft to `live`. */
  publishedBy: string;
  /** When the publish transition occurred. */
  publishedAt: string;
}

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
  /**
   * Maximum aggregate active coverage for this type, as a percentage of the
   * pool's locked capital (issue #134). Configurable via the coverage-type
   * admin API; enforced at buy() time against the sum of active coverage.
   */
  maxPoolExposurePct: number;
  /** Staged-rollout lifecycle state; only `live` products are public. */
  status: CoverageStatus;
  /** Present once the product has been published; absent while `draft`. */
  approval?: CoverageApprovalRecord;
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
    maxPoolExposurePct: 35,
    status: "live",
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
    maxPoolExposurePct: 35,
    status: "live",
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
    maxPoolExposurePct: 35,
    status: "live",
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
    maxPoolExposurePct: 30,
    status: "live",
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
    status: "live",
  },
} as const satisfies Record<CoverageType, CoverageProduct>;

/** List form of the catalog, in on-chain index order. */
export const COVERAGE_PRODUCTS: readonly CoverageProduct[] = Object.values(COVERAGE_CATALOG);

/**
 * Public catalog: only `live` products. QuoteService/PolicyService and any
 * other public-facing read must use this so a `draft` coverage type is fully
 * invisible to quote/buy flows.
 */
export const LIVE_COVERAGE_PRODUCTS: readonly CoverageProduct[] = COVERAGE_PRODUCTS.filter(
  (product) => product.status === "live",
);

/**
 * Admin preview catalog: every product regardless of status, so admins can
 * inspect staged drafts before publishing them.
 */
export const ALL_COVERAGE_PRODUCTS: readonly CoverageProduct[] = COVERAGE_PRODUCTS;

/**
 * Looks up a product by its numeric on-chain index. Returns undefined for
 * out-of-range indices so callers can raise their own domain error.
 *
 * By default only `live` products are returned; pass `{ includeDrafts: true }`
 * from admin-only preview paths to also resolve staged drafts.
 */
export function coverageProductByIndex(
  index: number,
  options: { includeDrafts?: boolean } = {},
): CoverageProduct | undefined {
  const source = options.includeDrafts ? ALL_COVERAGE_PRODUCTS : LIVE_COVERAGE_PRODUCTS;
  return source.find((product) => product.onChainIndex === index);
}

/**
 * Records a publish transition for a coverage product, returning a new product
 * object with `status: "live"` and the attached approval record. The original
 * product is not mutated, so callers can persist the returned value.
 */
export function publishCoverageProduct(
  product: CoverageProduct,
  publishedBy: string,
  publishedAt: string = new Date().toISOString(),
): CoverageProduct {
  return {
    ...product,
    status: "live",
    approval: {
      draftedBy: product.approval?.draftedBy ?? "unknown",
      draftedAt: product.approval?.draftedAt ?? publishedAt,
      publishedBy,
      publishedAt,
    },
  };
}

/**
 * Looks up a product by its canonical coverage-type id. Returns undefined for
 * unknown ids so callers can raise their own domain error.
 */
export function coverageProductById(id: CoverageType): CoverageProduct | undefined {
  return COVERAGE_CATALOG[id];
}

/**
 * Computes the maximum aggregate active coverage allowed for a coverage type
 * given the pool's currently locked capital (issue #134).
 *
 * The cap is a percentage of locked capital, so it scales with the pool's
 * size: e.g. a 30% cap on SmartContractRisk permits at most 30% of locked
 * capital to be simultaneously active in that type. Returns 0 when the pool
 * has no locked capital, which correctly blocks any new exposure.
 */
export function maxPoolExposureForType(
  id: CoverageType,
  lockedCapital: number,
): number {
  const product = COVERAGE_CATALOG[id];
  if (!product || lockedCapital <= 0) {
    return 0;
  }
  return (lockedCapital * product.maxPoolExposurePct) / 100;
}
