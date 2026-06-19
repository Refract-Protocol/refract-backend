import { Router, Request, Response } from "express";
import { z } from "zod";

const router = Router();

const DepositSchema = z.object({
  provider: z.string().min(56).max(56),
  amount: z.string().regex(/^\d+$/),
});

const WithdrawSchema = z.object({
  provider: z.string().min(56).max(56),
  shares: z.string().regex(/^\d+$/),
});

const mockPool = {
  totalUsdc: BigInt(18_400_000 * 1e7),
  totalShares: BigInt(17_800_000 * 1e7),
  lockedUsdc: BigInt(2_900_000 * 1e7), // locked covering active policies
  premiumAccrued: BigInt(284_000 * 1e7),
  utilizationBps: 1576, // 15.76%
  apyBps: 890,          // 8.9% from premiums
  sharePrice: 1.0319,
};

// GET /api/pool/stats
router.get("/stats", (_req: Request, res: Response) => {
  res.json({
    totalUsdc: mockPool.totalUsdc.toString(),
    totalShares: mockPool.totalShares.toString(),
    lockedUsdc: mockPool.lockedUsdc.toString(),
    premiumAccrued: mockPool.premiumAccrued.toString(),
    availableUsdc: (Number(mockPool.totalUsdc) - Number(mockPool.lockedUsdc)).toString(),
    utilizationBps: mockPool.utilizationBps,
    apyBps: mockPool.apyBps,
    sharePrice: mockPool.sharePrice,
    maxUtilizationBps: 8000,
  });
});

// GET /api/pool/user/:address
router.get("/user/:address", (req: Request, res: Response) => {
  const mockShares = BigInt(Math.floor(30_000 * 1e7));
  const usdcValue = Number(mockShares) * mockPool.sharePrice;
  res.json({
    address: req.params.address,
    shares: mockShares.toString(),
    usdcValue: usdcValue.toFixed(0),
    premiumEarned: (usdcValue * 0.089 * 0.5).toFixed(0),
    pct: ((Number(mockShares) / Number(mockPool.totalShares)) * 100).toFixed(4),
  });
});

// POST /api/pool/provide
router.post("/provide", async (req: Request, res: Response) => {
  const parse = DepositSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: parse.error.flatten() });

  const { provider, amount } = parse.data;
  const amountBn = BigInt(amount);
  const sharesOut = (amountBn * mockPool.totalShares) / mockPool.totalUsdc;

  return res.json({
    provider,
    amountUsdc: amount,
    sharesOut: sharesOut.toString(),
    sharePrice: mockPool.sharePrice,
    txXdr: "// TODO: Soroban invoke XDR",
    message: "Sign and submit to provide capital to Refract risk pool",
  });
});

// POST /api/pool/withdraw
router.post("/withdraw", async (req: Request, res: Response) => {
  const parse = WithdrawSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: parse.error.flatten() });

  const { provider, shares } = parse.data;
  const sharesBn = BigInt(shares);
  const usdcOut = (sharesBn * mockPool.totalUsdc) / mockPool.totalShares;
  const available = mockPool.totalUsdc - mockPool.lockedUsdc;

  if (usdcOut > available) {
    return res.status(400).json({
      error: "Pool capacity locked — too many active policies",
      available: available.toString(),
    });
  }

  return res.json({
    provider,
    sharesIn: shares,
    usdcOut: usdcOut.toString(),
    sharePrice: mockPool.sharePrice,
    txXdr: "// TODO: Soroban invoke XDR",
  });
});

// GET /api/pool/premium-history
router.get("/premium-history", (_req: Request, res: Response) => {
  const history = Array.from({ length: 30 }, (_, i) => ({
    date: new Date(Date.now() - i * 86400000).toISOString().split("T")[0],
    premiums: (4_000 + Math.random() * 12_000).toFixed(0),
    payouts: Math.random() > 0.9 ? (5_000 + Math.random() * 30_000).toFixed(0) : "0",
    apyBps: Math.floor(700 + Math.random() * 400),
  }));
  res.json({ history });
});

export { router as poolRouter };
export default router;
