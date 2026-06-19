import { Router } from "express";
import { z } from "zod";

export const quotesRouter = Router();

const COVERAGE_TYPES = [
  "StablecoinDepeg",
  "MarketCrash",
  "LiquidationShield",
  "SmartContractRisk",
  "FlightDelay",
] as const;

const QuoteSchema = z.object({
  coverageType: z.enum(COVERAGE_TYPES),
  coverageAmount: z.number().min(10).max(100_000),
  durationDays: z.number().int().min(1).max(365),
  triggerThreshold: z.number().optional(),
});

// Risk multipliers per coverage type
const RISK_MULTIPLIERS: Record<string, number> = {
  StablecoinDepeg: 1.0,
  MarketCrash: 1.5,
  LiquidationShield: 2.0,
  SmartContractRisk: 3.0,
  FlightDelay: 0.8,
};

const BASE_RATE = 0.03; // 3% annual base premium

function calcPremium(
  coverageAmount: number,
  coverageType: string,
  durationDays: number
): number {
  const annualPremium = coverageAmount * BASE_RATE * RISK_MULTIPLIERS[coverageType];
  const dailyPremium = annualPremium / 365;
  return parseFloat((dailyPremium * durationDays).toFixed(4));
}

// ── Routes ────────────────────────────────────────────────────────────────────

/** POST /api/v1/quotes — calculate a premium quote */
quotesRouter.post("/", (req, res) => {
  const result = QuoteSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: "Validation failed", details: result.error.flatten() });
  }

  const { coverageType, coverageAmount, durationDays, triggerThreshold } = result.data;

  const premium = calcPremium(coverageAmount, coverageType, durationDays);
  const defaultThreshold = {
    StablecoinDepeg: 500,      // 5%
    MarketCrash: 3000,         // 30%
    LiquidationShield: 100,    // any liquidation
    SmartContractRisk: 100,    // any exploit
    FlightDelay: 120,          // 2 hours
  }[coverageType];

  return res.json({
    coverageType,
    coverageAmount,
    premium,
    premiumPct: ((premium / coverageAmount) * 100).toFixed(4),
    durationDays,
    triggerThreshold: triggerThreshold ?? defaultThreshold,
    expiresAt: new Date(Date.now() + durationDays * 86_400_000).toISOString(),
    poolUtilization: "42%",  // live in production
    availableCapacity: "4,200,000",
  });
});

/** GET /api/v1/quotes/coverage-types — list available coverage with descriptions */
quotesRouter.get("/coverage-types", (_req, res) => {
  return res.json({
    types: [
      {
        id: "StablecoinDepeg",
        name: "Stablecoin Depeg",
        description: "Pays out if USDC/USDT depegs from $1 by more than 5%",
        trigger: "USDC < $0.95",
        riskLevel: "Low",
        maxDuration: 365,
        riskMultiplier: 1.0,
      },
      {
        id: "MarketCrash",
        name: "Market Crash",
        description: "Pays out if XLM or BTC drops >30% in a 24-hour window",
        trigger: ">30% 24h decline",
        riskLevel: "Medium",
        maxDuration: 90,
        riskMultiplier: 1.5,
      },
      {
        id: "LiquidationShield",
        name: "Liquidation Shield",
        description: "Covers loss from being auto-liquidated on NEXUS Protocol",
        trigger: "Position liquidated on NEXUS",
        riskLevel: "Medium-High",
        maxDuration: 30,
        riskMultiplier: 2.0,
      },
      {
        id: "SmartContractRisk",
        name: "Smart Contract Risk",
        description: "Compensates if a verified Soroban protocol is exploited",
        trigger: "Verified on-chain exploit",
        riskLevel: "High",
        maxDuration: 180,
        riskMultiplier: 3.0,
      },
      {
        id: "FlightDelay",
        name: "Flight Delay",
        description: "Pays out automatically if your flight is delayed >2 hours",
        trigger: ">2hr AviationStack-verified delay",
        riskLevel: "Very Low",
        maxDuration: 1,
        riskMultiplier: 0.8,
      },
    ],
  });
});
