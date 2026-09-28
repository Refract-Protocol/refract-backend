import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { DepositDto } from "./dto/deposit.dto";
import { WithdrawDto } from "./dto/withdraw.dto";
import {
  calculatePoolShareValue,
  calculateSharesOut,
  calculateUsdcOut,
  divideRoundNearest,
  formatFixedPercent,
  SHARE_PRICE_SCALE,
} from "./share-price.math";

// Mock pool state — replaced by a Postgres-backed (pool_snapshots table)
// read in a later PR that wires the app onto src/db/schema.sql.
const mockPool = {
  totalUsdc: 18_400_000n * 10_000_000n,
  totalShares: 17_800_000n * 10_000_000n,
  lockedUsdc: 2_900_000n * 10_000_000n, // locked covering active policies
  premiumAccrued: 284_000n * 10_000_000n,
  utilizationBps: 1576, // 15.76%
  apyBps: 890, // 8.9% from premiums
  sharePriceScaled: 10_319n,
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
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly poolContractId: string;

  constructor(private readonly configService: ConfigService<AppConfig, true>) {
    const stellar = this.configService.get("stellar", { infer: true });
    this.server = new rpc.Server(stellar.sorobanRpcUrl);
    this.networkPassphrase = stellar.networkPassphrase;
    this.poolContractId = stellar.poolContractId;
  }

  /**
   * Builds an unsigned, simulation-prepared invocation of the deployed
   * RefractPool contract for `provider` to sign in their own wallet —
   * provide_capital()/withdraw_capital() both call `require_auth()` on the
   * provider, so unlike ClaimSettlementService's relayer-signed flow, the
   * server can never sign this itself.
   */
  private async buildUnsignedInvoke(sourcePublicKey: string, method: string, args: xdr.ScVal[]): Promise<string> {
    if (!this.poolContractId) {
      throw new BadRequestException({ error: "Pool contract not configured (missing REFRACT_POOL_CONTRACT_ID)" });
    }
    try {
      const sourceAccount = await this.server.getAccount(sourcePublicKey);
      const contract = new Contract(this.poolContractId);
      const operation = contract.call(method, ...args);

      const builtTx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      // Simulates against the live contract and fills in Soroban resource
      // fees/footprint — surfaces contract-level rejections (e.g.
      // InsufficientCapacity, CapitalLocked) as part of building the tx,
      // rather than only after the caller signs and submits it.
      const preparedTx = await this.server.prepareTransaction(builtTx);
      return preparedTx.toXDR();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException({ error: `Failed to build Soroban transaction: ${message}` });
    }
  }

  /**
   * Reads RefractPool.lockup_expires_at(provider) via simulation — no
   * signature or submission needed, this never changes state. Returns
   * null if `provider` has never deposited (never locked) or the pool
   * contract isn't configured yet, matching the contract's own Option<u64>.
   */
  async lockupExpiresAt(provider: string): Promise<bigint | null> {
    if (!this.poolContractId) {
      return null;
    }
    try {
      const sourceAccount = await this.server.getAccount(provider);
      const contract = new Contract(this.poolContractId);
      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(contract.call("lockup_expires_at", new Address(provider).toScVal()))
        .setTimeout(30)
        .build();

      const sim = await this.server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) {
        throw new Error(sim.error);
      }
      const value = scValToNative(sim.result!.retval);
      return value === null ? null : BigInt(value as bigint);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException({ error: `Failed to read lockup status: ${message}` });
    }
  }

  getStats(): PoolStats {
    return {
      totalUsdc: mockPool.totalUsdc.toString(),
      totalShares: mockPool.totalShares.toString(),
      lockedUsdc: mockPool.lockedUsdc.toString(),
      premiumAccrued: mockPool.premiumAccrued.toString(),
      availableUsdc: (mockPool.totalUsdc - mockPool.lockedUsdc).toString(),
      utilizationBps: mockPool.utilizationBps,
      apyBps: mockPool.apyBps,
      sharePrice: Number(mockPool.sharePriceScaled) / Number(SHARE_PRICE_SCALE),
      maxUtilizationBps: 8000,
    };
  }

  getUserPosition(address: string) {
    const mockShares = 30_000n * 10_000_000n;
    const usdcValue = calculatePoolShareValue(mockShares, mockPool.sharePriceScaled);
    const premiumEarned = divideRoundNearest(usdcValue * BigInt(mockPool.apyBps), 20_000n);
    return {
      address,
      shares: mockShares.toString(),
      usdcValue: usdcValue.toString(),
      premiumEarned: premiumEarned.toString(),
      pct: formatFixedPercent(mockShares, mockPool.totalShares),
    };
  }

  async provide(dto: DepositDto) {
    const { provider, amount } = dto;
    const amountBn = BigInt(amount);
    if (amountBn <= 0n) {
      throw new BadRequestException({ error: "Deposit amount must be greater than zero" });
    }
    const sharesOut = calculateSharesOut(amountBn, mockPool.totalShares, mockPool.totalUsdc);

    const txXdr = await this.buildUnsignedInvoke(provider, "provide_capital", [
      new Address(provider).toScVal(),
      nativeToScVal(amountBn, { type: "i128" }),
    ]);

    return {
      provider,
      amountUsdc: amount,
      sharesOut: sharesOut.toString(),
      sharePrice: Number(mockPool.sharePriceScaled) / Number(SHARE_PRICE_SCALE),
      txXdr,
      message: "Sign and submit to provide capital to Refract risk pool",
    };
  }

  async withdraw(dto: WithdrawDto) {
    const { provider, shares } = dto;
    const sharesBn = BigInt(shares);
    if (sharesBn <= 0n) {
      throw new BadRequestException({ error: "Withdrawal shares must be greater than zero" });
    }

    // Fails fast with a clear message instead of letting the caller
    // discover the lockup only once buildUnsignedInvoke's simulation
    // rejects it with a raw contract error string.
    const lockupExpiresAt = await this.lockupExpiresAt(provider);
    if (lockupExpiresAt !== null && BigInt(Math.floor(Date.now() / 1000)) < lockupExpiresAt) {
      throw new BadRequestException({
        error: `Withdrawals are locked until ${new Date(Number(lockupExpiresAt) * 1000).toISOString()}`,
        lockupExpiresAt: lockupExpiresAt.toString(),
      });
    }

    const usdcOut = calculateUsdcOut(sharesBn, mockPool.totalUsdc, mockPool.totalShares);
    const available = mockPool.totalUsdc - mockPool.lockedUsdc;

    if (usdcOut > available) {
      throw new BadRequestException({
        error: "Pool capacity locked — too many active policies",
        available: available.toString(),
      });
    }

    const txXdr = await this.buildUnsignedInvoke(provider, "withdraw_capital", [
      new Address(provider).toScVal(),
      nativeToScVal(sharesBn, { type: "i128" }),
    ]);

    return {
      provider,
      sharesIn: shares,
      usdcOut: usdcOut.toString(),
      sharePrice: Number(mockPool.sharePriceScaled) / Number(SHARE_PRICE_SCALE),
      txXdr,
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
