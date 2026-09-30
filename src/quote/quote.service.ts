import { BadRequestException, Injectable } from "@nestjs/common";
import { COVERAGE_TYPES, coverageTypeByName } from "../common/coverage-types";
import { CoverageTypeName } from "./coverage-type";
import { CompareQuotesDto } from "./dto/compare-quotes.dto";
import { CreateQuoteDto } from "./dto/create-quote.dto";

export interface QuoteResult {
  coverageType: CoverageTypeName;
  coverageAmount: number;
  premium: number;
  premiumPct: string;
  durationDays: number;
  triggerThreshold: number;
  expiresAt: string;
  poolUtilization: string;
  availableCapacity: string;
}

/**
 * One coverage type's outcome within a comparison. A type whose own limits
 * reject the requested terms (e.g. Flight Delay beyond 1 day) is reported
 * with the same error body createQuote() would return, not omitted.
 */
export type QuoteComparisonEntry =
  | { coverageType: CoverageTypeName; status: "quoted"; quote: QuoteResult }
  | { coverageType: CoverageTypeName; status: "rejected"; error: string; maxDuration?: number };

export interface QuoteComparison {
  coverageAmount: number;
  durationDays: number;
  results: QuoteComparisonEntry[];
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

const DEFAULT_THRESHOLDS: Record<CoverageTypeName, number> = {
  [CoverageTypeName.StablecoinDepeg]: 500, // 5%
  [CoverageTypeName.MarketCrash]: 3000, // 30%
  [CoverageTypeName.LiquidationShield]: 100, // any liquidation
  [CoverageTypeName.SmartContractRisk]: 100, // any exploit
  [CoverageTypeName.FlightDelay]: 120, // 2 hours
};

const BASE_RATE = 0.03; // 3% annual base premium

@Injectable()
export class QuoteService {
  private calcPremium(coverageAmount: number, riskMultiplier: number, durationDays: number): number {
    const annualPremium = coverageAmount * BASE_RATE * riskMultiplier;
    const dailyPremium = annualPremium / 365;
    return parseFloat((dailyPremium * durationDays).toFixed(4));
  }

  createQuote(dto: CreateQuoteDto): QuoteResult {
    const { coverageType, coverageAmount, durationDays, triggerThreshold } = dto;

    // Each coverage type advertises its own maxDuration via
    // listCoverageTypes() (e.g. Flight Delay is capped at 1 day), but the
    // DTO only enforces a flat 365-day ceiling — this was the only place
    // that per-type limit was actually supposed to be checked.
    const catalogEntry = coverageTypeByName(coverageType);
    if (!catalogEntry) {
      throw new BadRequestException({ error: `Unknown coverage type: ${coverageType}` });
    }
    if (durationDays > catalogEntry.maxDuration) {
      throw new BadRequestException({
        error: `${catalogEntry.name} coverage is limited to ${catalogEntry.maxDuration} day(s)`,
        maxDuration: catalogEntry.maxDuration,
      });
    }

    const premium = this.calcPremium(coverageAmount, catalogEntry.riskMultiplier, durationDays);

    return {
      coverageType,
      coverageAmount,
      premium,
      premiumPct: ((premium / coverageAmount) * 100).toFixed(4),
      durationDays,
      triggerThreshold: triggerThreshold ?? DEFAULT_THRESHOLDS[coverageType],
      expiresAt: new Date(Date.now() + durationDays * 86_400_000).toISOString(),
      poolUtilization: "42%", // live in production
      availableCapacity: "4,200,000",
    };
  }

  /**
   * Quotes the same amount and duration across several coverage types.
   * Each type goes through createQuote() so pricing and per-type
   * validation stay in one place; a per-type rejection is captured in its
   * entry instead of failing the whole comparison. Results follow the
   * catalog order regardless of the order requested.
   */
  compareQuotes(dto: CompareQuotesDto): QuoteComparison {
    const { coverageAmount, durationDays, coverageTypes } = dto;
    const requested = new Set(coverageTypes ?? Object.values(CoverageTypeName));

    const results = Object.values(CoverageTypeName)
      .filter((coverageType) => requested.has(coverageType))
      .map((coverageType): QuoteComparisonEntry => {
        try {
          return { coverageType, status: "quoted", quote: this.createQuote({ coverageType, coverageAmount, durationDays }) };
        } catch (err) {
          if (!(err instanceof BadRequestException)) throw err;
          const body = err.getResponse() as { error: string; maxDuration?: number };
          return { coverageType, status: "rejected", error: body.error, maxDuration: body.maxDuration };
        }
      });

    return { coverageAmount, durationDays, results };
  }

  listCoverageTypes(): CoverageTypeInfo[] {
    return COVERAGE_TYPES.map(({ key, name, description, trigger, riskLevel, maxDuration, riskMultiplier }) => ({
      id: key,
      name,
      description,
      trigger,
      riskLevel,
      maxDuration,
      riskMultiplier,
    }));
  }
}
