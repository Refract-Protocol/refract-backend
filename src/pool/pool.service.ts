import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { DepositDto } from "./dto/deposit.dto";
import { WithdrawDto } from "./dto/withdraw.dto";

/** Share price fixed-point scale (1.0 == 10_000_000) — matches 1e7 money units. */
export const SHARE_PRICE_SCALE = 10_000_000n;

const POOL_STATE_CACHE_TTL_MS = 2_000;
const MAX_UTILIZATION_BPS = 8000;

export type PoolStats =
  | { available: false; reason: string }
  | {
      available: true;
      totalUsdc: string;
      totalShares: string;
      lockedUsdc: string;
      premiumAccrued: string;
      availableUsdc: string;
      utilizationBps: number;
      apyBps: number;
      sharePriceE7: string;
      maxUtilizationBps: number;
      ledger: number;
      readAt: string;
    };

export type UserPosition =
  | { available: false; reason: string }
  | {
      available: true;
      address: string;
      shares: string;
      usdcValue: string;
      premiumEarned: string;
      pct: string;
      sharePriceE7: string;
      ledger: number;
      readAt: string;
    };

export interface PremiumHistoryEntry {
  date: string;
  premiums: string;
  payouts: string;
  apyBps: number;
}

/** Live RefractPool view snapshot — monetary fields are 1e7 fixed-point bigints. */
interface LivePoolState {
  totalUsdc: bigint;
  totalShares: bigint;
  lockedUsdc: bigint;
  premiumAccrued: bigint;
  ledger: number;
  readAt: string;
}

@Injectable()
export class PoolService {
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly poolContractId: string;

  /** Short-TTL cache so bursty getStats/provide/withdraw don't fan out RPC. */
  private poolStateCache: { state: LivePoolState; expiresAt: number } | null = null;
  /** Single-flight: concurrent readers share one in-flight fetch. */
  private poolStateInFlight: Promise<LivePoolState> | null = null;

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
   * Reads a zero-arg RefractPool view method via simulation — no signature
   * or submission, this never changes state. Same pattern as
   * PolicyService.onChainCoverageBounds(): a well-formed dummy source
   * account is enough for the tx envelope; it never touches the network
   * via getAccount().
   *
   * Returns the native (scValToNative) result plus the simulation's
   * latestLedger so callers can stamp read metadata.
   */
  private async simulateView<T>(method: string): Promise<{ value: T; ledger: number }> {
    if (!this.poolContractId) {
      throw new BadRequestException({ error: "Pool contract not configured (missing REFRACT_POOL_CONTRACT_ID)" });
    }
    const dummySource = new Account(Keypair.random().publicKey(), "0");
    const contract = new Contract(this.poolContractId);
    const tx = new TransactionBuilder(dummySource, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(method))
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(sim.error);
    }
    const value = scValToNative(sim.result!.retval) as T;
    const ledger = typeof sim.latestLedger === "number" ? sim.latestLedger : 0;
    return { value, ledger };
  }

  /** Reads RefractPool.total_usdc() via simulation. */
  async totalUsdc(): Promise<bigint> {
    const { value } = await this.simulateView<bigint>("total_usdc");
    return BigInt(value as bigint);
  }

  /** Reads RefractPool.total_shares() via simulation. */
  async totalShares(): Promise<bigint> {
    const { value } = await this.simulateView<bigint>("total_shares");
    return BigInt(value as bigint);
  }

  /** Reads RefractPool.locked_usdc() via simulation. */
  async lockedUsdc(): Promise<bigint> {
    const { value } = await this.simulateView<bigint>("locked_usdc");
    return BigInt(value as bigint);
  }

  /** Reads RefractPool.premium_accrued() via simulation. */
  async premiumAccrued(): Promise<bigint> {
    const { value } = await this.simulateView<bigint>("premium_accrued");
    return BigInt(value as bigint);
  }

  /**
   * Fetches the four pool view methods sequentially (deterministic call
   * order for tests/mocks) and stamps a single readAt / max ledger.
   */
  private async fetchLivePoolState(): Promise<LivePoolState> {
    const readAt = new Date().toISOString();
    const usdc = await this.simulateView<bigint>("total_usdc");
    const shares = await this.simulateView<bigint>("total_shares");
    const locked = await this.simulateView<bigint>("locked_usdc");
    const premium = await this.simulateView<bigint>("premium_accrued");

    return {
      totalUsdc: BigInt(usdc.value as bigint),
      totalShares: BigInt(shares.value as bigint),
      lockedUsdc: BigInt(locked.value as bigint),
      premiumAccrued: BigInt(premium.value as bigint),
      ledger: Math.max(usdc.ledger, shares.ledger, locked.ledger, premium.ledger),
      readAt,
    };
  }

  /**
   * Cached + single-flight live pool snapshot. Returns null when the pool
   * contract isn't configured — never fabricates numbers. Simulation /
   * decode failures propagate as BadRequestException (same shape as
   * lockupExpiresAt).
   */
  private async readLivePoolState(): Promise<LivePoolState | null> {
    if (!this.poolContractId) {
      return null;
    }
    const now = Date.now();
    if (this.poolStateCache && this.poolStateCache.expiresAt > now) {
      return this.poolStateCache.state;
    }
    if (this.poolStateInFlight) {
      return this.poolStateInFlight;
    }

    this.poolStateInFlight = this.fetchLivePoolState()
      .then((state) => {
        this.poolStateCache = { state, expiresAt: Date.now() + POOL_STATE_CACHE_TTL_MS };
        return state;
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        throw new BadRequestException({ error: `Failed to read pool state: ${message}` });
      })
      .finally(() => {
        this.poolStateInFlight = null;
      });

    return this.poolStateInFlight;
  }

  /** Fixed-point e7 share price: totalUsdc * SCALE / totalShares (1.0 when empty). */
  private sharePriceE7(totalUsdc: bigint, totalShares: bigint): bigint {
    if (totalUsdc === 0n || totalShares === 0n) {
      return SHARE_PRICE_SCALE;
    }
    return (totalUsdc * SHARE_PRICE_SCALE) / totalShares;
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
   * Live pool stats via Soroban simulation. Returns `{ available: false }`
   * when the pool contract isn't configured — never invents numbers.
   */
  async getStats(): Promise<PoolStats> {
    if (!this.poolContractId) {
      return {
        available: false,
        reason: "Pool contract not configured (missing REFRACT_POOL_CONTRACT_ID)",
      };
    }
    const state = await this.readLivePoolState();
    if (!state) {
      return {
        available: false,
        reason: "Pool contract not configured (missing REFRACT_POOL_CONTRACT_ID)",
      };
    }

    const availableUsdc = state.totalUsdc - state.lockedUsdc;
    const utilizationBps =
      state.totalUsdc === 0n ? 0 : Number((state.lockedUsdc * 10_000n) / state.totalUsdc);
    const sharePriceE7 = this.sharePriceE7(state.totalUsdc, state.totalShares);

    return {
      available: true,
      totalUsdc: state.totalUsdc.toString(),
      totalShares: state.totalShares.toString(),
      lockedUsdc: state.lockedUsdc.toString(),
      premiumAccrued: state.premiumAccrued.toString(),
      availableUsdc: availableUsdc.toString(),
      utilizationBps,
      apyBps: 0, // not on-chain yet
      sharePriceE7: sharePriceE7.toString(),
      maxUtilizationBps: MAX_UTILIZATION_BPS,
      ledger: state.ledger,
      readAt: state.readAt,
    };
  }

  /**
   * Provider share balances aren't read from chain here yet — return
   * unavailable rather than fabricating a position (no mock shares / floats).
   */
  async getUserPosition(_address: string): Promise<UserPosition> {
    if (!this.poolContractId) {
      return {
        available: false,
        reason: "Pool contract not configured (missing REFRACT_POOL_CONTRACT_ID)",
      };
    }
    return {
      available: false,
      reason: "User share balance is not available from live pool state",
    };
  }

  async provide(dto: DepositDto) {
    const { provider, amount } = dto;
    const amountBn = BigInt(amount);
    if (amountBn <= 0n) {
      throw new BadRequestException({ error: "Deposit amount must be greater than zero" });
    }

    const state = await this.readLivePoolState();
    if (!state) {
      throw new BadRequestException({ error: "Pool contract not configured (missing REFRACT_POOL_CONTRACT_ID)" });
    }

    // Empty pool (no USDC or no shares): first deposit is 1:1 sharesOut=amount.
    const sharesOut =
      state.totalUsdc === 0n || state.totalShares === 0n
        ? amountBn
        : (amountBn * state.totalShares) / state.totalUsdc;
    const sharePriceE7 = this.sharePriceE7(state.totalUsdc, state.totalShares);

    const txXdr = await this.buildUnsignedInvoke(provider, "provide_capital", [
      new Address(provider).toScVal(),
      nativeToScVal(amountBn, { type: "i128" }),
    ]);

    return {
      provider,
      amountUsdc: amount,
      sharesOut: sharesOut.toString(),
      sharePriceE7: sharePriceE7.toString(),
      ledger: state.ledger,
      readAt: state.readAt,
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

    const state = await this.readLivePoolState();
    if (!state) {
      throw new BadRequestException({ error: "Pool contract not configured (missing REFRACT_POOL_CONTRACT_ID)" });
    }
    if (state.totalShares === 0n) {
      throw new BadRequestException({ error: "Cannot withdraw: pool has zero shares outstanding" });
    }

    const usdcOut = (sharesBn * state.totalUsdc) / state.totalShares;
    const available = state.totalUsdc - state.lockedUsdc;
    const sharePriceE7 = this.sharePriceE7(state.totalUsdc, state.totalShares);

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
      sharePriceE7: sharePriceE7.toString(),
      ledger: state.ledger,
      readAt: state.readAt,
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
