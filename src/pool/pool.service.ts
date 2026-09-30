import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Account,
  BASE_FEE,
  Keypair,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import {
  decodeLockupExpiresAt,
  decodePoolState,
  decodeProviderPosition,
  encodeLockupExpiresAt,
  encodeProvideCapital,
  encodeProviderPosition,
  encodeWithdrawCapital,
  poolOperation,
} from "../stellar/contracts/refract-pool";
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

// Short TTL for the per-address position read: a stale share balance shown
// next to a withdrawal quote is the same class of bug this read fixes, so
// keep it brief while still shielding the RPC provider from fan-out.
const POSITION_CACHE_TTL_MS = 5_000;

// Stellar ed25519 public keys are StrKey-encoded as a 56-char base32 string
// beginning with "G". Validating before any RPC call keeps the endpoint from
// being used to fan garbage at the RPC provider.
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

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

export interface UserPosition {
  address: string;
  shares: string;
  usdcValue: string;
  premiumEarned: string;
  pct: string;
  lockupExpiresAt: string | null;
  readAt: string;
}

interface CachedPosition {
  value: UserPosition;
  expiresAt: number;
}

@Injectable()
export class PoolService {
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly poolContractId: string;
  private readonly positionCache = new Map<string, CachedPosition>();
  private readonly positionInFlight = new Map<string, Promise<UserPosition>>();

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
  private async buildUnsignedInvoke(
    sourcePublicKey: string,
    method: "provide_capital" | "withdraw_capital",
    args: xdr.ScVal[],
  ): Promise<string> {
    if (!this.poolContractId) {
      throw new BadRequestException({ error: "Pool contract not configured (missing REFRACT_POOL_CONTRACT_ID)" });
    }
    try {
      const sourceAccount = await this.server.getAccount(sourcePublicKey);
      const operation = poolOperation(this.poolContractId, method, args);

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
   * Simulates a read-only contract invocation. Uses a throwaway source
   * account (as onChainCoverageBounds does) rather than the provider's own
   * account: view simulations never touch the network, so requiring the
   * provider account to exist would spuriously fail for an unfunded
   * provider that has never interacted with the pool.
   */
  private async simulateRead(method: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
    const sourceAccount = new Account(Keypair.random().publicKey(), "0");
    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(poolOperation(this.poolContractId, method, args))
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(sim.error);
    }
    return sim.result!.retval;
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
      const retval = await this.simulateRead("lockup_expires_at", encodeLockupExpiresAt(provider));
      return decodeLockupExpiresAt(retval);
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
      sharePrice: mockPool.sharePrice,
      maxUtilizationBps: 8000,
    };
  }

  /**
   * Reads the provider's real share balance and premium entitlement from
   * the pool contract, consolidating position, lockup expiry and premium
   * into a single response so the frontend needs one call instead of two.
   *
   * Honest semantics, matching lockupExpiresAt:
   *  - unconfigured contract  -> explicit zero-position (no RPC attempted)
   *  - provider with no stake -> explicit zero-position (distinguishable
   *    from an error, which still surfaces as a BadRequestException)
   *  - simulation failure     -> BadRequestException
   *
   * All arithmetic is BigInt fixed-point (shares are i128); no floats.
   */
  async getUserPosition(address: string): Promise<UserPosition> {
    if (!STELLAR_ADDRESS_RE.test(address)) {
      throw new BadRequestException({ error: "Invalid Stellar address" });
    }

    const cached = this.positionCache.get(address);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    // Single-flight: concurrent requests for the same address share one RPC
    // round-trip instead of each fanning out to the provider.
    const inFlight = this.positionInFlight.get(address);
    if (inFlight) {
      return inFlight;
    }

    const pending = this.readUserPosition(address)
      .then((value) => {
        this.positionCache.set(address, { value, expiresAt: Date.now() + POSITION_CACHE_TTL_MS });
        return value;
      })
      .finally(() => {
        this.positionInFlight.delete(address);
      });

    this.positionInFlight.set(address, pending);
    return pending;
  }

  private async readUserPosition(address: string): Promise<UserPosition> {
    const readAt = new Date().toISOString();

    if (!this.poolContractId) {
      return this.zeroPosition(address, readAt);
    }

    try {
      const [positionRetval, stateRetval, lockupExpiresAt] = await Promise.all([
        this.simulateRead("provider_position", encodeProviderPosition(address)),
        this.simulateRead("pool_state", []),
        this.lockupExpiresAt(address),
      ]);

      const position = decodeProviderPosition(positionRetval);
      const state = decodePoolState(stateRetval);

      const shares = position.shares;
      const totalShares = state.totalShares;

      // usdcValue = shares * totalUsdc / totalShares, all BigInt fixed-point.
      // Guard division by zero when the pool holds no shares yet.
      const usdcValue = totalShares > 0n ? (shares * state.totalUsdc) / totalShares : 0n;
      const premiumEarned = position.premiumEarned;
      const pct =
        totalShares > 0n
          ? ((shares * 1_000_000n) / totalShares).toString()
          : "0";

      return {
        address,
        shares: shares.toString(),
        usdcValue: usdcValue.toString(),
        premiumEarned: premiumEarned.toString(),
        pct,
        lockupExpiresAt: lockupExpiresAt === null ? null : lockupExpiresAt.toString(),
        readAt,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException({ error: `Failed to read user position: ${message}` });
    }
  }

  private zeroPosition(address: string, readAt: string): UserPosition {
    return {
      address,
      shares: "0",
      usdcValue: "0",
      premiumEarned: "0",
      pct: "0",
      lockupExpiresAt: null,
      readAt,
    };
  }

  async provide(dto: DepositDto) {
    const { provider, amount } = dto;
    const amountBn = BigInt(amount);
    if (amountBn <= 0n) {
      throw new BadRequestException({ error: "Deposit amount must be greater than zero" });
    }
    const sharesOut = (amountBn * mockPool.totalShares) / mockPool.totalUsdc;

    const txXdr = await this.buildUnsignedInvoke(
      provider,
      "provide_capital",
      encodeProvideCapital(provider, amountBn),
    );

    return {
      provider,
      amountUsdc: amount,
      sharesOut: sharesOut.toString(),
      sharePrice: mockPool.sharePrice,
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

    const usdcOut = (sharesBn * mockPool.totalUsdc) / mockPool.totalShares;
    const available = mockPool.totalUsdc - mockPool.lockedUsdc;

    if (usdcOut > available) {
      throw new BadRequestException({
        error: "Pool capacity locked — too many active policies",
        available: available.toString(),
      });
    }

    const txXdr = await this.buildUnsignedInvoke(
      provider,
      "withdraw_capital",
      encodeWithdrawCapital(provider, sharesBn),
    );

    return {
      provider,
      sharesIn: shares,
      usdcOut: usdcOut.toString(),
      sharePrice: mockPool.sharePrice,
      txXdr,
    };
  }

  getPremiumHistory(): PremiumHistoryEntry[] {
    return Array.from({ length: 30 }, (_, i) => ({
      date: new Date(Date.now() - i * 86400000).toISOString().split("T")[0],
      premiums: (4_000 + Math.random() * 12_000).toFixed(0),
      payouts: Math.random() > 0.9 ? (5_000 + Math.random() * 20_000).toFixed(0) : "0",
      apyBps: 890,
    }));
  }
}
