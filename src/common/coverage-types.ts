import { CoverageTypeName } from "../quote/coverage-type";

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
  /**
   * Maximum share of the pool's locked capital that may be actively exposed
   * to this coverage type at once, as a percentage (0-100). Enforced at
   * `buy()` time against the sum of active coverage in this type so capital
   * cannot concentrate in a single risk category. Configurable via the
   * coverage-type admin API alongside the rest of this catalog.
   */
  maxPoolExposurePct: number;
  trigger: string;
  icon: string;
}

/**
 * The single coverage-type catalog shared by PolicyService and
 * QuoteService. Entries are in on-chain declaration order, so
 * `COVERAGE_TYPES[i].id === i` for every entry.
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
    maxPoolExposurePct: 40,
    trigger: "USDC price < $0.95 for 15+ minutes",
    icon: "🪙",
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
    maxPoolExposurePct: 30,
    trigger: "Market index 24h return < -30%",
    icon: "📉",
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
    maxPoolExposurePct: 30,
    trigger: "Collateral ratio drops below maintenance threshold",
    icon: "🛡️",
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
    maxPoolExposurePct: 30,
    trigger: "Covered protocol TVL drops >50% in <1 hour",
    icon: "🔐",
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
    maxPoolExposurePct: 10,
    trigger: "Flight delayed > 120 minutes per AviationStack data",
    icon: "✈️",
  },
];

/** Lookup by on-chain discriminant (PolicyService's numeric `coverageType`). */
export function coverageTypeById(id: number): CoverageType | undefined {
  return COVERAGE_TYPES.find((t) => t.id === id);
}

/** Lookup by `CoverageTypeName` (QuoteService's `coverageType`). */
export function coverageTypeByName(name: CoverageTypeName): CoverageType | undefined {
  return COVERAGE_TYPES.find((t) => t.key === name);
}
