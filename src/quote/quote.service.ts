import { Injectable } from "@nestjs/common";
import { CoverageTypeName } from "./coverage-type";
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

@Injectable()
export class QuoteService {
  private calcPremium(coverageAmount: number, coverageType: CoverageTypeName, durationDays: number): number {
    const annualPremium = coverageAmount * BASE_RATE * RISK_MULTIPLIERS[coverageType];
    const dailyPremium = annualPremium / 365;
    return parseFloat((dailyPremium * durationDays).toFixed(4));
  }

  createQuote(dto: CreateQuoteDto): QuoteResult {
    const { coverageType, coverageAmount, durationDays, triggerThreshold } = dto;
    const premium = this.calcPremium(coverageAmount, coverageType, durationDays);

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

  listCoverageTypes(): CoverageTypeInfo[] {
    return COVERAGE_TYPES;
  }
}
