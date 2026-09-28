import { BadRequestException, Injectable, Logger } from "@nestjs/common";
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
import { LpPositionRepository } from "./lp-position.repository";
import { PoolSnapshotRepository } from "./pool-snapshot.repository";
import { PremiumRevenueRepository } from "./premium-revenue.repository";
import { WithdrawDto } from "./dto/withdraw.dto";

/**
 * Fallback values used only when the pool_snapshots table is empty
 * (e.g. fresh environment before the snapshot scheduler has run). These
 * are clearly labelled and never silently returned as real data — callers
 * receive a `stale: true` flag so they know the numbers are bootstrapped.
 */
const BOOTSTRAP_POOL = {
  totalUsdc: BigInt(0),
  totalShares: BigInt(0),
  lockedUsdc: BigInt(0),
  premiumAccrued: BigInt(0),
  utilizationBps: 0,
  apyBps: 0,
  sharePrice: 1.0,
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
  /** True when no pool_snapshots row exists yet and bootstrap values are returned. */
  stale?: boolean;
}

export interface PremiumHistoryEntry {
  date: string;
  premiums: string;
  payouts: string;
  apyBps: number;
}

@Injectable()
export class PoolService {
  private readonly logger = new Logger(PoolService.name);
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly poolContractId: string;

  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly poolSnapshotRepository: PoolSnapshotRepository,
    private readonly lpPositionRepository: LpPositionRepository,
    private readonly premiumRevenueRepository: PremiumRevenueRepository
  ) {
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

  /**
   * Returns pool stats from the latest pool_snapshots row.
   * Falls back to zero-value bootstrap stats (with stale: true) when the
   * table is empty — the snapshot scheduler populates it on its first run.
   */
  async getStats(): Promise<PoolStats> {
    const snapshot = await this.poolSnapshotRepository.getLatest();
    if (!snapshot) {
      this.logger.warn("pool_snapshots table is empty — returning bootstrap stats");
      const pool = BOOTSTRAP_POOL;
      return {
        totalUsdc: pool.totalUsdc.toString(),
        totalShares: pool.totalShares.toString(),
        lockedUsdc: pool.lockedUsdc.toString(),
        premiumAccrued: pool.premiumAccrued.toString(),
        availableUsdc: "0",
        utilizationBps: pool.utilizationBps,
        apyBps: pool.apyBps,
        sharePrice: pool.sharePrice,
        maxUtilizationBps: 8000,
        stale: true,
      };
    }
    return this.poolSnapshotRepository.toStats(snapshot);
  }

  /**
   * Returns the real LP position for `address` from the lp_positions table.
   * Returns null shares/values when the address has never deposited, rather
   * than fabricating a fake position.
   */
  async getUserPosition(address: string) {
    const position = await this.lpPositionRepository.findByProvider(address);

    if (!position) {
      return {
        address,
        shares: "0",
        usdcValue: "0",
        premiumEarned: "0",
        pct: "0.0000",
        deposited: false,
      };
    }

    // Share price from the latest snapshot; fall back to 1.0 if not yet available.
    const snapshot = await this.poolSnapshotRepository.getLatest();
    const sharePrice = snapshot?.sharePrice ?? 1.0;
    const totalShares = snapshot?.totalShares ?? 0n;

    const usdcValue = Number(position.shares) * sharePrice;
    const pct =
      totalShares > 0n
        ? ((Number(position.shares) / Number(totalShares)) * 100).toFixed(4)
        : "0.0000";

    return {
      address,
      shares: position.shares.toString(),
      usdcValue: usdcValue.toFixed(0),
      premiumEarned: position.premiumEarned.toString(),
      pct,
      deposited: true,
      firstDeposit: position.firstDeposit.toISOString(),
      lastUpdated: position.lastUpdated.toISOString(),
    };
  }

  async provide(dto: DepositDto) {
    const { provider, amount } = dto;
    const amountBn = BigInt(amount);
    if (amountBn <= 0n) {
      throw new BadRequestException({ error: "Deposit amount must be greater than zero" });
    }

    const snapshot = await this.poolSnapshotRepository.getLatest();
    const totalUsdc = snapshot?.totalUsdc ?? BOOTSTRAP_POOL.totalUsdc;
    const totalShares = snapshot?.totalShares ?? BOOTSTRAP_POOL.totalShares;
    const sharePrice = snapshot?.sharePrice ?? BOOTSTRAP_POOL.sharePrice;

    // Avoid division by zero on a freshly-initialised pool.
    const sharesOut =
      totalUsdc > 0n && totalShares > 0n
        ? (amountBn * totalShares) / totalUsdc
        : amountBn; // 1:1 for the first deposit

    const txXdr = await this.buildUnsignedInvoke(provider, "provide_capital", [
      new Address(provider).toScVal(),
      nativeToScVal(amountBn, { type: "i128" }),
    ]);

    return {
      provider,
      amountUsdc: amount,
      sharesOut: sharesOut.toString(),
      sharePrice,
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

    const snapshot = await this.poolSnapshotRepository.getLatest();
    const totalUsdc = snapshot?.totalUsdc ?? BOOTSTRAP_POOL.totalUsdc;
    const totalShares = snapshot?.totalShares ?? BOOTSTRAP_POOL.totalShares;
    const lockedUsdc = snapshot?.lockedUsdc ?? BOOTSTRAP_POOL.lockedUsdc;
    const sharePrice = snapshot?.sharePrice ?? BOOTSTRAP_POOL.sharePrice;

    const usdcOut =
      totalShares > 0n ? (sharesBn * totalUsdc) / totalShares : 0n;
    const available = totalUsdc - lockedUsdc;

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
      sharePrice,
      txXdr,
    };
  }

  /**
   * Returns real daily premium + payout aggregates for the last 30 days
   * from the premium_revenue and claims tables, derived via SQL. Returns
   * an empty array when no data has been recorded yet — no fabrication.
   */
  async getPremiumHistory(): Promise<PremiumHistoryEntry[]> {
    return this.premiumRevenueRepository.getDailyHistory(30);
  }
}
