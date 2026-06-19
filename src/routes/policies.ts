import { Router, Request, Response } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";

const router = Router();

const BuyPolicySchema = z.object({
  holder: z.string().min(56).max(56),
  coverageType: z.number().int().min(0).max(4),
  coverageAmount: z.string().regex(/^\d+$/), // USDC in 1e7
  durationDays: z.number().int().min(1).max(365),
  triggerParams: z.record(z.unknown()).optional(),
});

const RISK_MULTIPLIERS = [1.0, 1.5, 2.0, 3.0, 0.8];
const BASE_RATE_BPS = 300; // 3% annual

const COVERAGE_NAMES = [
  "Stablecoin Depeg",
  "Market Crash",
  "Liquidation Shield",
  "Smart Contract Risk",
  "Flight Delay",
];

// In-memory store (production: PostgreSQL)
const policies: Map<string, Record<string, unknown>> = new Map();

// GET /api/policies/types
router.get("/types", (_req: Request, res: Response) => {
  res.json({
    coverageTypes: [
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
    ],
  });
});

// GET /api/policies/holder/:address
router.get("/holder/:address", (req: Request, res: Response) => {
  const holderPolicies = [...policies.values()].filter(
    (p) => p.holder === req.params.address
  );
  res.json({ policies: holderPolicies });
});

// GET /api/policies/:id
router.get("/:id", (req: Request, res: Response) => {
  const policy = policies.get(req.params.id);
  if (!policy) return res.status(404).json({ error: "Policy not found" });
  return res.json({ policy });
});

// POST /api/policies/buy — build buy-policy tx
router.post("/buy", async (req: Request, res: Response) => {
  const parse = BuyPolicySchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: parse.error.flatten() });
  }

  const { holder, coverageType, coverageAmount, durationDays } = parse.data;
  const coverage = BigInt(coverageAmount);
  const multiplier = RISK_MULTIPLIERS[coverageType];
  const ratePerDay = (BASE_RATE_BPS * multiplier) / 36500;
  const premiumBps = ratePerDay * durationDays;
  const premium = BigInt(Math.floor(Number(coverage) * premiumBps));

  const policyId = uuidv4();
  const expiresAt = Math.floor(Date.now() / 1000) + durationDays * 86400;

  const policy = {
    id: policyId,
    holder,
    coverageType,
    coverageTypeName: COVERAGE_NAMES[coverageType],
    coverageAmount: coverageAmount,
    premium: premium.toString(),
    durationDays,
    expiresAt,
    isActive: true,
    createdAt: new Date().toISOString(),
  };

  policies.set(policyId, policy);

  return res.json({
    policy,
    txXdr: "// TODO: Soroban invoke XDR",
    message: "Sign and submit to activate coverage",
  });
});

export { router as policiesRouter };
export default router;
