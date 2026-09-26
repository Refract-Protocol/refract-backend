import { BadRequestException, Injectable } from "@nestjs/common";
import { CoverageTypeName } from "./coverage-type";
import { CreateQuoteDto } from "./dto/create-quote.dto";

/**
 * Narrow view of pool state a quote needs to assess capacity.
 *
 * Implemented by PoolModule and injected into QuoteService so the quote
 * module depends on this interface rather than on PoolService wholesale.
 */
export interface PoolCapacityProvider {
  getCapacity(): Promise<PoolCapacitySnapshot>;
}

export interface PoolCapacitySnapshot {
  /** Pool utilization in basis points (e.g. 4200 = 42%). */
  utilizationBps: number;
  /** Utilization ceiling in basis points (e.g. 8000 = 80%). */
  maxUtilizationBps: number;
  /** Remaining underwriting capacity in 1e7 base units, as a decimal string. */
  availableCapacity: string;
  /** When the underlying pool state was read. */
  readAt: string;
}

export interface QuoteCapacityAssessment {
  /** Whether the requested coverage fits within available capacity. */
  withinCapacity: boolean;
  /** Human-readable explanation of the assessment. */
  reason: string;
}

export interface QuoteResult {
  coverageType: CoverageTypeName;
  coverageAmount: number;
  premium: number;
  premiumPct: string;
  durationDays: number;
  triggerThreshold: number;
  expiresAt: string;
  /**
   * Pool utilization in basis points, or null when pool state is unavailable.
   *
   * BREAKING: previously a pre-formatted display string (e.g. "42%").
   * Display formatting is now the client's responsibility.
   */
  utilizationBps: number | null;
  /**
   * Remaining underwriting capacity in 1e7 base units as a decimal string,
   * or null when pool state is unavailable.
   *
   * BREAKING: previously a pre-formatted display string (e.g. "4,200,000").
   */
  availableCapacity: string | null;
  /** Whether the requested coverage fits the pool's capacity. */
  withinCapacity: boolean | null;
  /** Explanation of the capacity assessment, or why it could not be made. */
  capacityReason: string;
  /** When the pool state backing this quote was read, or null if unavailable. */
  capacityReadAt: string | null;
}

export interface CoverageTypeInfo {
  id: CoverageTypeName;
  name: string;
  description: string;
  trigger: string;
  riskLevel: string;
  maxDuration: number;
  riskMultiplier: number;
}

const RISK_MULTIPLIERS: Record<CoverageTypeName, number> = {
  [CoverageTypeName.StablecoinDepeg]: 1.0,
  [CoverageTypeName.MarketCrash]: 1.5,
  [CoverageTypeName.LiquidationShield]: 2.0,
  [CoverageTypeName.SmartContractRisk]: 3.0,
  [CoverageTypeName.FlightDelay]: 0.8,
};

const DEFAULT_THRESHOLDS: Record<CoverageTypeName, number> = {
  [CoverageTypeName.StablecoinDepeg]: 500, // 5%
  [CoverageTypeName.MarketCrash]: 3000, // 30%
  [CoverageTypeName.LiquidationShield]: 100, // any liquidation
  [CoverageTypeName.SmartContractRisk]: 100, // any exploit
  [CoverageTypeName.FlightDelay]: 120, // 2 hours
};

const BASE_RATE = 0.03; // 3% annual base premium

const COVERAGE_TYPES: CoverageTypeInfo[] = [
  {
    id: CoverageTypeName.StablecoinDepeg,
    name: "Stablecoin Depeg",
    description: "Pays out if USDC/USDT depegs from $1 by more than 5%",
    trigger: "USDC < $0.95",
    riskLevel: "Low",
    maxDuration: 365,
    riskMultiplier: 1.0,
  },
  {
    id: CoverageTypeName.MarketCrash,
    name: "Market Crash",
    description: "Pays out if XLM or BTC drops >30% in a 24-hour window",
    trigger: ">30% 24h decline",
    riskLevel: "Medium",
    maxDuration: 90,
    riskMultiplier: 1.5,
  },
  {
    id: CoverageTypeName.LiquidationShield,
    name: "Liquidation Shield",
    description: "Covers loss from being auto-liquidated on NEXUS Protocol",
    trigger: "Position liquidated on NEXUS",
    riskLevel: "Medium-High",
    maxDuration: 30,
    riskMultiplier: 2.0,
  },
  {
    id: CoverageTypeName.SmartContractRisk,
    name: "Smart Contract Risk",
    description: "Compensates if a verified Soroban protocol is exploited",
    trigger: "Verified on-chain exploit",
    riskLevel: "High",
    maxDuration: 180,
    riskMultiplier: 3.0,
  },
  {
    id: CoverageTypeName.FlightDelay,
    name: "Flight Delay",
    description: "Pays out automatically if your flight is delayed >2 hours",
    trigger: ">2hr AviationStack-verified delay",
    riskLevel: "Very Low",
    maxDuration: 1,
    riskMultiplier: 0.8,
  },
];

const BASE_UNITS = 10_000_000n; // 1e7 base units per whole unit

@Injectable()
export class QuoteService {
  constructor(private readonly poolCapacity: PoolCapacityProvider) {}

  private calcPremium(coverageAmount: number, coverageType: CoverageTypeName, durationDays: number): number {
    const annualPremium = coverageAmount * BASE_RATE * RISK_MULTIPLIERS[coverageType];
    const dailyPremium = annualPremium / 365;
    return parseFloat((dailyPremium * durationDays).toFixed(4));
  }

  private assessCapacity(
    coverageAmount: number,
    snapshot: PoolCapacitySnapshot,
  ): QuoteCapacityAssessment {
    // availableCapacity is a BigInt-derived value; keep it in BigInt space
    // rather than routing it through Number.
    let available: bigint;
    try {
      available = BigInt(snapshot.availableCapacity);
    } catch {
      return {
        withinCapacity: false,
        reason: "Pool available capacity could not be parsed",
      };
    }

    const requested = BigInt(Math.round(coverageAmount)) * BASE_UNITS;

    if (requested > available) {
      return {
        withinCapacity: false,
        reason: "Requested coverage exceeds the pool's available capacity",
      };
    }

    // Projected utilization after writing this policy, in basis points.
    const totalCapacity = available + (BigInt(snapshot.utilizationBps) * available) / BigInt(10_000 - snapshot.utilizationBps || 1);
    const projectedBps =
      totalCapacity > 0n
        ? Number(((available - requested + (totalCapacity - available)) * 10_000n) / totalCapacity)
        : 0;

    if (projectedBps > snapshot.maxUtilizationBps) {
      return {
        withinCapacity: false,
        reason: `Writing this policy would push utilization to ${projectedBps} bps, above the ${snapshot.maxUtilizationBps} bps ceiling`,
      };
    }

    return {
      withinCapacity: true,
      reason: "Requested coverage fits within the pool's available capacity",
    };
  }

  async createQuote(dto: CreateQuoteDto): Promise<QuoteResult> {
    const { coverageType, coverageAmount, durationDays, triggerThreshold } = dto;

    // Each coverage type advertises its own maxDuration via
    // listCoverageTypes() (e.g. Flight Delay is capped at 1 day), but the
    // DTO only enforces a flat 365-day ceiling — this was the only place
    // that per-type limit was actually supposed to be checked.
    const catalogEntry = COVERAGE_TYPES.find((t) => t.id === coverageType);
    if (catalogEntry && durationDays > catalogEntry.maxDuration) {
      throw new BadRequestException({
        error: `${catalogEntry.name} coverage is limited to ${catalogEntry.maxDuration} day(s)`,
        maxDuration: catalogEntry.maxDuration,
      });
    }

    const premium = this.calcPremium(coverageAmount, coverageType, durationDays);

    let snapshot: PoolCapacitySnapshot | null = null;
    try {
      snapshot = await this.poolCapacity.getCapacity();
    } catch {
      snapshot = null;
    }

    const assessment = snapshot
      ? this.assessCapacity(coverageAmount, snapshot)
      : null;

    return {
      coverageType,
      coverageAmount,
      premium,
      premiumPct: ((premium / coverageAmount) * 100).toFixed(4),
      durationDays,
      triggerThreshold: triggerThreshold ?? DEFAULT_THRESHOLDS[coverageType],
      expiresAt: new Date(Date.now() + durationDays * 86_400_000).toISOString(),
      utilizationBps: snapshot ? snapshot.utilizationBps : null,
      availableCapacity: snapshot ? snapshot.availableCapacity : null,
      withinCapacity: assessment ? assessment.withinCapacity : null,
      capacityReason: assessment
        ? assessment.reason
        : "Pool state unavailable; capacity could not be assessed",
      capacityReadAt: snapshot ? snapshot.readAt : null,
    };
  }

  listCoverageTypes(): CoverageTypeInfo[] {
    return COVERAGE_TYPES;
  }
}
