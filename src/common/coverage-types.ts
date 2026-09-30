import { CoverageTypeName } from "../quote/coverage-type";

/**
 * Lifecycle state of a coverage product. New products are staged as `draft`
 * (visible only to admins via the preview endpoint) and must be explicitly
 * published to become `live` and appear in the public catalog.
 */
export type CoverageTypeStatus = "draft" | "live";

/**
 * Auditable record of a coverage-type publish event: who drafted the product
 * and who separately published it, with timestamps for each transition.
 */
export interface CoverageTypeApproval {
  draftedBy: string;
  draftedAt: string;
  publishedBy: string;
  publishedAt: string;
}

/**
 * One coverage product. `id` is the on-chain discriminant — the position of
 * the variant in refract-contracts/pool/src/lib.rs's `CoverageType` enum,
 * which buy-policy.dto.ts validates as 0-4 — and `key` is both the
 * `CoverageTypeName` the quote API accepts and the variant's Symbol name
 * on-chain, so the two lookup styles always resolve to the same entry.
 */
export interface CoverageType {
  id: number;
  key: CoverageTypeName;
  name: string;
  description: string;
  riskLevel: string;
  riskMultiplier: number;
  baseRatePct: number;
  /** Per-type product cap in USDC, stricter than the pool's global bound. */
  maxCoverage: number;
  /** Longest policy term offered, in days. */
  maxDuration: number;
  trigger: string;
  icon: string;
  /** Staged-rollout state; only `live` entries are public. */
  status: CoverageTypeStatus;
  /** Present once a draft has been published. */
  approval?: CoverageTypeApproval;
}

/**
 * The single coverage-type catalog shared by PolicyService and
 * QuoteService. Entries are in on-chain declaration order, so
 * `COVERAGE_TYPES[i].id === i` for every entry. All built-in products ship
 * `live`; newly staged products start as `draft` and are excluded from the
 * public catalog until published.
 */
export const COVERAGE_TYPES: readonly CoverageType[] = [
  {
    id: 0,
    key: CoverageTypeName.StablecoinDepeg,
    name: "Stablecoin Depeg",
    description: "Pays out if a major stablecoin depegs below $0.95",
    riskLevel: "medium",
    riskMultiplier: 1.0,
    baseRatePct: 3.0,
    maxCoverage: 100_000,
    maxDuration: 365,
    trigger: "USDC price < $0.95 for 15+ minutes",
    icon: "🪙",
    status: "live",
  },
  {
    id: 1,
    key: CoverageTypeName.MarketCrash,
    name: "Market Crash",
    description: "Covers catastrophic market downturns exceeding 30% in 24h",
    riskLevel: "high",
    riskMultiplier: 1.5,
    baseRatePct: 4.5,
    maxCoverage: 50_000,
    maxDuration: 90,
    trigger: "Market index 24h return < -30%",
    icon: "📉",
    status: "live",
  },
  {
    id: 2,
    key: CoverageTypeName.LiquidationShield,
    name: "Liquidation Shield",
    description: "Pays out if your DeFi position gets liquidated",
    riskLevel: "high",
    riskMultiplier: 2.0,
    baseRatePct: 6.0,
    maxCoverage: 200_000,
    maxDuration: 30,
    trigger: "Collateral ratio drops below maintenance threshold",
    icon: "🛡️",
    status: "live",
  },
  {
    id: 3,
    key: CoverageTypeName.SmartContractRisk,
    name: "Smart Contract Risk",
    description: "Protection against smart contract exploits and hacks",
    riskLevel: "critical",
    riskMultiplier: 3.0,
    baseRatePct: 9.0,
    maxCoverage: 500_000,
    maxDuration: 180,
    trigger: "Covered protocol TVL drops >50% in <1 hour",
    icon: "🔐",
    status: "live",
  },
  {
    id: 4,
    key: CoverageTypeName.FlightDelay,
    name: "Flight Delay",
    description: "Automatic payout for flight delays over 2 hours",
    riskLevel: "low",
    riskMultiplier: 0.8,
    baseRatePct: 2.4,
    maxCoverage: 2_000,
    maxDuration: 1,
    trigger: "Flight delayed > 120 minutes per AviationStack data",
    icon: "✈️",
    status: "live",
  },
];

/**
 * Public catalog: only `live` coverage types. QuoteService/PolicyService and
 * any public-facing read must use this so drafts stay invisible to
 * quote/buy flows.
 */
export const LIVE_COVERAGE_TYPES: readonly CoverageType[] = COVERAGE_TYPES.filter(
  (t) => t.status === "live",
);

/**
 * Admin preview catalog: every coverage type regardless of status, so admins
 * can inspect staged drafts before publishing.
 */
export const ALL_COVERAGE_TYPES: readonly CoverageType[] = COVERAGE_TYPES;

/** Lookup by on-chain discriminant (PolicyService's numeric `coverageType`). */
export function coverageTypeById(id: number): CoverageType | undefined {
  return COVERAGE_TYPES.find((t) => t.id === id);
}

/** Lookup by `CoverageTypeName` (QuoteService's `coverageType`). */
export function coverageTypeByName(name: CoverageTypeName): CoverageType | undefined {
  return COVERAGE_TYPES.find((t) => t.key === name);
}

/**
 * Public-facing lookup by on-chain discriminant. Returns `undefined` for
 * drafts so quote/buy flows can never resolve a not-yet-published product.
 */
export function liveCoverageTypeById(id: number): CoverageType | undefined {
  return LIVE_COVERAGE_TYPES.find((t) => t.id === id);
}

/**
 * Public-facing lookup by `CoverageTypeName`. Returns `undefined` for drafts
 * so quote/buy flows can never resolve a not-yet-published product.
 */
export function liveCoverageTypeByName(name: CoverageTypeName): CoverageType | undefined {
  return LIVE_COVERAGE_TYPES.find((t) => t.key === name);
}

/**
 * Stage a new coverage type as a `draft`. The returned entry is not part of
 * the public catalog until `publishCoverageType` records an approval and
 * flips its status to `live`.
 */
export function draftCoverageType(
  input: Omit<CoverageType, "status" | "approval">,
  draftedBy: string,
  draftedAt: string = new Date().toISOString(),
): CoverageType {
  return {
    ...input,
    status: "draft",
    approval: { draftedBy, draftedAt, publishedBy: "", publishedAt: "" },
  };
}

/**
 * Transition a draft to `live`, recording who published it and when. Returns
 * `undefined` if the entry is missing or already live, so the caller can
 * surface a 404/409 without mutating state.
 */
export function publishCoverageType(
  id: number,
  publishedBy: string,
  publishedAt: string = new Date().toISOString(),
): CoverageType | undefined {
  const entry = COVERAGE_TYPES.find((t) => t.id === id);
  if (!entry || entry.status === "live") {
    return undefined;
  }
  entry.status = "live";
  entry.approval = {
    draftedBy: entry.approval?.draftedBy ?? "",
    draftedAt: entry.approval?.draftedAt ?? "",
    publishedBy,
    publishedAt,
  };
  return entry;
}
