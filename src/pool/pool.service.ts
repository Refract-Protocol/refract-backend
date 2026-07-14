import { BadRequestException, Injectable } from "@nestjs/common";
import { DepositDto } from "./dto/deposit.dto";
import { WithdrawDto } from "./dto/withdraw.dto";

// Mock pool state — replaced by a Postgres-backed (pool_snapshots table)
// read in a later PR that wires the app onto src/db/schema.sql.
const mockPool = {
  totalUsdc: BigInt(18_400_000 * 1e7),
  totalShares: BigInt(17_800_000 * 1e7),
  lockedUsdc: BigInt(2_900_000 * 1e7), // locked covering active policies
  premiumAccrued: BigInt(284_000 * 1e7),
  utilizationBps: 1576, // 15.76%
  apyBps: 890, // 8.9% from premiums
  sharePrice: 1.0319,
};

export interface PoolStats {
  totalUsdc: string;
  totalShares: string;
  lockedUsdc: string;
  premiumAccrued: string;
  availableUsdc: string;
  utilizationBps: number;
  apyBps: number;
  sharePrice: number;
  maxUtilizationBps: number;
}

export interface PremiumHistoryEntry {
  date: string;
  premiums: string;
  payouts: string;
  apyBps: number;
}

@Injectable()
export class PoolService {
  getStats(): PoolStats {
    return {
      totalUsdc: mockPool.totalUsdc.toString(),
      totalShares: mockPool.totalShares.toString(),
      lockedUsdc: mockPool.lockedUsdc.toString(),
      premiumAccrued: mockPool.premiumAccrued.toString(),
      availableUsdc: (mockPool.totalUsdc - mockPool.lockedUsdc).toString(),
      utilizationBps: mockPool.utilizationBps,
      apyBps: mockPool.apyBps,
      sharePrice: mockPool.sharePrice,
      maxUtilizationBps: 8000,
    };
  }

  getUserPosition(address: string) {
    const mockShares = BigInt(Math.floor(30_000 * 1e7));
    const usdcValue = Number(mockShares) * mockPool.sharePrice;
    return {
      address,
      shares: mockShares.toString(),
      usdcValue: usdcValue.toFixed(0),
      premiumEarned: (usdcValue * 0.089 * 0.5).toFixed(0),
      pct: ((Number(mockShares) / Number(mockPool.totalShares)) * 100).toFixed(4),
    };
  }

  provide(dto: DepositDto) {
    const { provider, amount } = dto;
    const amountBn = BigInt(amount);
    const sharesOut = (amountBn * mockPool.totalShares) / mockPool.totalUsdc;

    return {
      provider,
      amountUsdc: amount,
      sharesOut: sharesOut.toString(),
      sharePrice: mockPool.sharePrice,
      txXdr: "// TODO: Soroban invoke XDR",
      message: "Sign and submit to provide capital to Refract risk pool",
    };
  }

  withdraw(dto: WithdrawDto) {
    const { provider, shares } = dto;
    const sharesBn = BigInt(shares);
    const usdcOut = (sharesBn * mockPool.totalUsdc) / mockPool.totalShares;
    const available = mockPool.totalUsdc - mockPool.lockedUsdc;

    if (usdcOut > available) {
      throw new BadRequestException({
        error: "Pool capacity locked — too many active policies",
        available: available.toString(),
      });
    }

    return {
      provider,
      sharesIn: shares,
      usdcOut: usdcOut.toString(),
      sharePrice: mockPool.sharePrice,
      txXdr: "// TODO: Soroban invoke XDR",
    };
  }

  getPremiumHistory(): PremiumHistoryEntry[] {
    return Array.from({ length: 30 }, (_, i) => ({
      date: new Date(Date.now() - i * 86400000).toISOString().split("T")[0],
      premiums: (4_000 + Math.random() * 12_000).toFixed(0),
      payouts: Math.random() > 0.9 ? (5_000 + Math.random() * 30_000).toFixed(0) : "0",
      apyBps: Math.floor(700 + Math.random() * 400),
    }));
  }
}
