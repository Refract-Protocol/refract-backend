import { BadRequestException, Injectable } from "@nestjs/common";
import { CoverageTypeName } from "./coverage-type";
import { CreateQuoteDto } from "./dto/create-quote.dto";
import { COVERAGE_PRODUCTS, getCoverageProduct } from "../common/coverage-catalog";

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

export interface CoverageTypeInfo {
  id: CoverageTypeName;
  name: string;
  description: string;
  trigger: string;
  riskLevel: string;
  maxDuration: number;
  riskMultiplier: number;
}

const BASE_RATE = 0.03; // 3% annual base premium

@Injectable()
export class QuoteService {
  private calcPremium(coverageAmount: number, coverageType: CoverageTypeName, durationDays: number): number {
    const annualPremium = coverageAmount * BASE_RATE * getCoverageProduct(coverageType).riskMultiplier;
    const dailyPremium = annualPremium / 365;
    return parseFloat((dailyPremium * durationDays).toFixed(4));
  }

  createQuote(dto: CreateQuoteDto): QuoteResult {
    const { coverageType, coverageAmount, durationDays, triggerThreshold } = dto;

    // Each coverage type advertises its own maxDuration via
    // listCoverageTypes() (e.g. Flight Delay is capped at 1 day), but the
    // DTO only enforces a flat 365-day ceiling — this was the only place
    // that per-type limit was actually supposed to be checked.
    const catalogEntry = getCoverageProduct(coverageType);
    if (catalogEntry && durationDays > catalogEntry.maxDuration) {
      throw new BadRequestException({
        error: `${catalogEntry.name} coverage is limited to ${catalogEntry.maxDuration} day(s)`,
        maxDuration: catalogEntry.maxDuration,
      });
    }

    const premium = this.calcPremium(coverageAmount, coverageType, durationDays);

    return {
      coverageType,
      coverageAmount,
      premium,
      premiumPct: ((premium / coverageAmount) * 100).toFixed(4),
      durationDays,
      triggerThreshold: triggerThreshold ?? catalogEntry.defaultThreshold,
      expiresAt: new Date(Date.now() + durationDays * 86_400_000).toISOString(),
      poolUtilization: "42%", // live in production
      availableCapacity: "4,200,000",
    };
  }

  listCoverageTypes(): CoverageTypeInfo[] {
    return COVERAGE_PRODUCTS.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      trigger: p.trigger,
      riskLevel: p.riskLevel,
      maxDuration: p.maxDuration,
      riskMultiplier: p.riskMultiplier,
    }));
  }
}
