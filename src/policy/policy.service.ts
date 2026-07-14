import { Injectable } from "@nestjs/common";
import { v4 as uuidv4 } from "uuid";
import { BuyPolicyDto } from "./dto/buy-policy.dto";

export interface CoverageTypeCatalogEntry {
  id: number;
  name: string;
  description: string;
  riskLevel: string;
  riskMultiplier: number;
  baseRatePct: number;
  maxCoverage: number;
  trigger: string;
  icon: string;
}

export interface StoredPolicy {
  id: string;
  holder: string;
  coverageType: number;
  coverageTypeName: string;
  coverageAmount: string;
  premium: string;
  durationDays: number;
  expiresAt: number;
  isActive: boolean;
  createdAt: string;
}

const RISK_MULTIPLIERS = [1.0, 1.5, 2.0, 3.0, 0.8];
const BASE_RATE_BPS = 300; // 3% annual

const COVERAGE_NAMES = [
  "Stablecoin Depeg",
  "Market Crash",
  "Liquidation Shield",
  "Smart Contract Risk",
  "Flight Delay",
];

const COVERAGE_TYPES: CoverageTypeCatalogEntry[] = [
  {
    id: 0,
    name: "Stablecoin Depeg",
    description: "Pays out if a major stablecoin depegs below $0.95",
    riskLevel: "medium",
    riskMultiplier: 1.0,
    baseRatePct: 3.0,
    maxCoverage: 100_000,
    trigger: "USDC price < $0.95 for 15+ minutes",
    icon: "🪙",
  },
  {
    id: 1,
    name: "Market Crash",
    description: "Covers catastrophic market downturns exceeding 30% in 24h",
    riskLevel: "high",
    riskMultiplier: 1.5,
    baseRatePct: 4.5,
    maxCoverage: 50_000,
    trigger: "Market index 24h return < -30%",
    icon: "📉",
  },
  {
    id: 2,
    name: "Liquidation Shield",
    description: "Pays out if your DeFi position gets liquidated",
    riskLevel: "high",
    riskMultiplier: 2.0,
    baseRatePct: 6.0,
    maxCoverage: 200_000,
    trigger: "Collateral ratio drops below maintenance threshold",
    icon: "🛡️",
  },
  {
    id: 3,
    name: "Smart Contract Risk",
    description: "Protection against smart contract exploits and hacks",
    riskLevel: "critical",
    riskMultiplier: 3.0,
    baseRatePct: 9.0,
    maxCoverage: 500_000,
    trigger: "Covered protocol TVL drops >50% in <1 hour",
    icon: "🔐",
  },
  {
    id: 4,
    name: "Flight Delay",
    description: "Automatic payout for flight delays over 2 hours",
    riskLevel: "low",
    riskMultiplier: 0.8,
    baseRatePct: 2.4,
    maxCoverage: 2_000,
    trigger: "Flight delayed > 120 minutes per AviationStack data",
    icon: "✈️",
  },
];

@Injectable()
export class PolicyService {
  // In-memory store — replaced by the Postgres-backed repository in a
  // follow-up PR that wires the app onto src/db/schema.sql.
  private readonly policies = new Map<string, StoredPolicy>();

  listTypes(): CoverageTypeCatalogEntry[] {
    return COVERAGE_TYPES;
  }

  findByHolder(address: string): StoredPolicy[] {
    return [...this.policies.values()].filter((p) => p.holder === address);
  }

  findById(id: string): StoredPolicy | undefined {
    return this.policies.get(id);
  }

  buy(dto: BuyPolicyDto): { policy: StoredPolicy; txXdr: string; message: string } {
    const { holder, coverageType, coverageAmount, durationDays } = dto;
    const coverage = BigInt(coverageAmount);
    const multiplier = RISK_MULTIPLIERS[coverageType];
    const ratePerDay = (BASE_RATE_BPS * multiplier) / 36500;
    const premiumBps = ratePerDay * durationDays;
    const premium = BigInt(Math.floor(Number(coverage) * premiumBps));

    const policyId = uuidv4();
    const expiresAt = Math.floor(Date.now() / 1000) + durationDays * 86400;

    const policy: StoredPolicy = {
      id: policyId,
      holder,
      coverageType,
      coverageTypeName: COVERAGE_NAMES[coverageType],
      coverageAmount,
      premium: premium.toString(),
      durationDays,
      expiresAt,
      isActive: true,
      createdAt: new Date().toISOString(),
    };

    this.policies.set(policyId, policy);

    return {
      policy,
      txXdr: "// TODO: Soroban invoke XDR",
      message: "Sign and submit to activate coverage",
    };
  }
}
