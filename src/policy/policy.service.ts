import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { v4 as uuidv4 } from "uuid";
import { AppConfig } from "../config/configuration";
import { BuyPolicyDto } from "./dto/buy-policy.dto";

/** Off-chain lifecycle: pending until buy_policy confirms, then active, then inactive after claim/expiry. */
export type PolicyStatus = "pending" | "active" | "inactive";

const FLIGHT_DELAY_COVERAGE_TYPE = 4;

/**
 * Mirrors refract-contracts/pool/src/lib.rs's `CoverageType` enum, in
 * declaration order — buy-policy.dto.ts's `coverageType` is validated as
 * 0-4 against exactly this ordering.
 */
const COVERAGE_TYPE_VARIANTS = [
  "StablecoinDepeg",
  "MarketCrash",
  "LiquidationShield",
  "SmartContractRisk",
  "FlightDelay",
] as const;

/**
 * trigger_threshold per coverage type, in the units process_claim() compares
 * against (see lib.rs): bps for StablecoinDepeg/MarketCrash, minutes for
 * FlightDelay. LiquidationShield/SmartContractRisk trigger on
 * `oracle_value > 0` and never read trigger_threshold, so its value there is
 * inert — kept non-zero only for consistency with the other entries.
 */
const TRIGGER_THRESHOLDS = [500, 3000, 500, 500, 120];

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
  /** Internal off-chain UUID — never sent to process_claim. */
  id: string;
  /**
   * On-chain u64 from buy_policy()'s return value, as a decimal string so
   * values above Number.MAX_SAFE_INTEGER round-trip exactly. Null until
   * the buy transaction confirms.
   */
  onChainPolicyId: string | null;
  holder: string;
  coverageType: number;
  coverageTypeName: string;
  coverageAmount: string;
  premium: string;
  durationDays: number;
  expiresAt: number;
  /** Explicit state machine; listActive() only returns `active`. */
  status: PolicyStatus;
  /** Derived convenience: true iff status === "active". */
  isActive: boolean;
  createdAt: string;
  /**
   * Hash of the prepared buy_policy envelope (signature-base hash — identical
   * before and after the holder signs). Used to correlate TxService.submit
   * confirmations back to this pending record.
   */
  pendingTxHash: string | null;
  /** Wall-clock ms when a pending policy should be swept if never submitted. */
  pendingExpiresAt: number | null;
  triggerParams?: Record<string, unknown>;
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
  private readonly logger = new Logger(PolicyService.name);
  // In-memory store — replaced by the Postgres-backed repository in a
  // follow-up PR that wires the app onto src/db/schema.sql.
  private readonly policies = new Map<string, StoredPolicy>();
  /** pendingTxHash → internal policy UUID for confirmation correlation. */
  private readonly pendingByTxHash = new Map<string, string>();

  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly poolContractId: string;
  private readonly pendingTtlMs: number;

  constructor(private readonly configService: ConfigService<AppConfig, true>) {
    const stellar = this.configService.get("stellar", { infer: true });
    this.server = new rpc.Server(stellar.sorobanRpcUrl);
    this.networkPassphrase = stellar.networkPassphrase;
    this.poolContractId = stellar.poolContractId;
    this.pendingTtlMs = this.configService.get("policyPendingTtlMs", { infer: true });
  }

  /**
   * buy_policy(holder, params: PolicyParams) is called against
   * RefractPool, not a separate policy contract — the pool takes the
   * premium and mirrors the new policy into RefractPolicyRegistry itself
   * (see pool/src/lib.rs). PolicyParams is a `#[contracttype]` struct,
   * which soroban-sdk's derive serializes as a Map<Symbol, Val> with
   * entries sorted by field name (confirmed against
   * soroban-sdk-macros::derive_struct's `sorted_by_key` on the field
   * ident) — hence the alphabetical key order below. CoverageType is a
   * unit-variant enum, which serializes as a one-element vec holding the
   * variant name as a Symbol (confirmed against
   * soroban-sdk-macros::derive_enum's map_empty_variant).
   */
  private buildPolicyParamsScVal(
    coverageType: number,
    coverageAmount: bigint,
    durationDays: number,
    triggerThreshold: number
  ): xdr.ScVal {
    return xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("coverage_amount"),
        val: nativeToScVal(coverageAmount, { type: "i128" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("coverage_type"),
        val: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(COVERAGE_TYPE_VARIANTS[coverageType])]),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("duration_days"),
        val: nativeToScVal(durationDays, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("trigger_threshold"),
        val: nativeToScVal(triggerThreshold, { type: "i128" }),
      }),
    ]);
  }

  /**
   * Builds an unsigned, simulation-prepared buy_policy() invocation for
   * `holder` to sign in their own wallet — buy_policy() calls
   * `require_auth()` on the holder, so the server can never sign this
   * itself.
   */
  private async buildUnsignedBuyInvoke(holder: string, paramsScVal: xdr.ScVal): Promise<string> {
    if (!this.poolContractId) {
      throw new BadRequestException({ error: "Pool contract not configured (missing REFRACT_POOL_CONTRACT_ID)" });
    }
    try {
      const sourceAccount = await this.server.getAccount(holder);
      const contract = new Contract(this.poolContractId);
      const operation = contract.call("buy_policy", new Address(holder).toScVal(), paramsScVal);

      const builtTx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const preparedTx = await this.server.prepareTransaction(builtTx);
      return preparedTx.toXDR();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException({ error: `Failed to build Soroban transaction: ${message}` });
    }
  }

  /**
   * Reads RefractPool.pool_config()'s min_coverage/max_coverage via
   * simulation — no signature or submission, this never changes state.
   * Returns null if the pool contract isn't configured or hasn't been
   * initialized on-chain yet (pool_config() itself returns None then).
   *
   * The pool enforces ONE global min/max coverage across every coverage
   * type (see _check_coverage_capacity in pool/src/lib.rs) — there's no
   * per-type bound on-chain, unlike COVERAGE_TYPES' maxCoverage below,
   * which is this catalog's own (stricter, per-type) product policy. Both
   * checks apply: the catalog caps what buy() will offer per type, this
   * catches the case where that per-type cap is still above whatever the
   * pool is actually configured to allow right now — e.g. after an admin
   * calls set_pool_config() — which the catalog alone can't see.
   */
  async onChainCoverageBounds(): Promise<{ minCoverage: bigint; maxCoverage: bigint } | null> {
    if (!this.poolContractId) {
      return null;
    }
    try {
      // pool_config() is a stateless view with no caller-specific args, so
      // the source account only needs to be well-formed for the tx
      // envelope — it never touches the network, unlike getAccount().
      const dummySource = new Account(Keypair.random().publicKey(), "0");
      const contract = new Contract(this.poolContractId);
      const tx = new TransactionBuilder(dummySource, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(contract.call("pool_config"))
        .setTimeout(30)
        .build();

      const sim = await this.server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) {
        throw new Error(sim.error);
      }
      const config = scValToNative(sim.result!.retval) as {
        min_coverage: bigint;
        max_coverage: bigint;
      } | null;
      if (!config) return null;
      return { minCoverage: config.min_coverage, maxCoverage: config.max_coverage };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BadRequestException({ error: `Failed to read pool config: ${message}` });
    }
  }

  listTypes(): CoverageTypeCatalogEntry[] {
    return COVERAGE_TYPES;
  }

  findByHolder(address: string): StoredPolicy[] {
    return [...this.policies.values()].filter((p) => p.holder === address);
  }

  findById(id: string): StoredPolicy | undefined {
    return this.policies.get(id);
  }

  /** Active, unexpired policies — the pool ClaimService scans for triggers. Pending never appears. */
  listActive(): StoredPolicy[] {
    this.sweepExpiredPending();
    const now = Math.floor(Date.now() / 1000);
    return [...this.policies.values()].filter((p) => p.status === "active" && p.expiresAt > now);
  }

  /** Marks a policy inactive after a claim has been paid out. */
  deactivate(id: string): void {
    const policy = this.policies.get(id);
    if (policy) {
      policy.status = "inactive";
      policy.isActive = false;
      this.policies.set(id, policy);
    }
  }

  /**
   * Called from TxService once a submitted envelope confirms. Matches by
   * transaction hash (not trust in the caller), decodes the buy_policy u64
   * return value, and transitions pending → active.
   */
  activateFromBuyConfirmation(txHash: string, returnValue: xdr.ScVal | undefined): StoredPolicy | null {
    this.sweepExpiredPending();
    const policyId = this.pendingByTxHash.get(txHash);
    if (!policyId) {
      return null;
    }
    const policy = this.policies.get(policyId);
    if (!policy || policy.status !== "pending") {
      this.pendingByTxHash.delete(txHash);
      return null;
    }

    if (returnValue === undefined) {
      this.logger.error(`buy_policy confirmed (tx=${txHash}) but RPC returned no returnValue for policy ${policyId}`);
      return null;
    }

    const native = scValToNative(returnValue);
    // buy_policy returns u64 — scValToNative yields bigint. Reject anything else.
    if (typeof native !== "bigint") {
      this.logger.error(
        `buy_policy return value for policy ${policyId} was not a u64/bigint (got ${typeof native})`
      );
      return null;
    }

    policy.onChainPolicyId = native.toString(10);
    policy.status = "active";
    policy.isActive = true;
    policy.pendingTxHash = null;
    policy.pendingExpiresAt = null;
    this.policies.set(policyId, policy);
    this.pendingByTxHash.delete(txHash);
    this.logger.log(
      `Policy ${policyId} activated with on-chain id ${policy.onChainPolicyId} (tx=${txHash})`
    );
    return policy;
  }

  /** Drop pending policies whose submit window has elapsed (user never submitted, or submitted too late). */
  sweepExpiredPending(): number {
    const now = Date.now();
    let swept = 0;
    for (const [id, policy] of this.policies) {
      if (policy.status === "pending" && policy.pendingExpiresAt !== null && policy.pendingExpiresAt <= now) {
        if (policy.pendingTxHash) this.pendingByTxHash.delete(policy.pendingTxHash);
        this.policies.delete(id);
        swept++;
      }
    }
    return swept;
  }

  async buy(dto: BuyPolicyDto): Promise<{ policy: StoredPolicy; txXdr: string; message: string }> {
    const { holder, coverageType, coverageAmount, durationDays, triggerParams } = dto;

    if (coverageType === FLIGHT_DELAY_COVERAGE_TYPE && typeof triggerParams?.flightNumber !== "string") {
      throw new BadRequestException({
        error: "Flight Delay coverage requires triggerParams.flightNumber",
      });
    }

    const coverage = BigInt(coverageAmount);
    if (coverage <= 0n) {
      throw new BadRequestException({ error: "coverageAmount must be greater than zero" });
    }

    // listTypes() advertises maxCoverage per catalog entry, but nothing
    // enforced it here — a buyer could request coverage far beyond the
    // advertised cap (e.g. 500,000 on a Flight Delay policy capped at
    // 2,000) and it would be silently accepted. The Soroban pool contract
    // enforces the equivalent check in buy_policy(); mirror it here.
    const maxCoverage = COVERAGE_TYPES[coverageType].maxCoverage;
    if (coverage > BigInt(maxCoverage) * 10_000_000n) {
      throw new BadRequestException({
        error: `coverageAmount exceeds the ${COVERAGE_NAMES[coverageType]} maximum of ${maxCoverage} USDC`,
        maxCoverage,
      });
    }

    // The catalog check above is this service's own per-type policy, but
    // the pool enforces a single global bound across every type (see
    // onChainCoverageBounds' doc comment) — one that could be far tighter
    // (or, after a set_pool_config() change, looser) than what the catalog
    // advertises. Catch a mismatch here with a specific error instead of
    // letting buildUnsignedBuyInvoke's simulation fail it opaquely.
    const bounds = await this.onChainCoverageBounds();
    if (bounds && (coverage < bounds.minCoverage || coverage > bounds.maxCoverage)) {
      throw new BadRequestException({
        error: `coverageAmount must be between ${bounds.minCoverage} and ${bounds.maxCoverage} (pool contract units) per the pool's current configuration`,
        minCoverage: bounds.minCoverage.toString(),
        maxCoverage: bounds.maxCoverage.toString(),
      });
    }

    const multiplier = RISK_MULTIPLIERS[coverageType];
    const annualRate = (BASE_RATE_BPS / 10_000) * multiplier; // bps -> fraction, e.g. 300bps * 1.0 = 0.03 (3%)
    const dailyRate = annualRate / 365;
    const premiumFraction = dailyRate * durationDays;
    const premium = BigInt(Math.floor(Number(coverage) * premiumFraction));

    const policyId = uuidv4();
    const expiresAt = Math.floor(Date.now() / 1000) + durationDays * 86400;

    const paramsScVal = this.buildPolicyParamsScVal(
      coverageType,
      coverage,
      durationDays,
      TRIGGER_THRESHOLDS[coverageType]
    );
    const txXdr = await this.buildUnsignedBuyInvoke(holder, paramsScVal);

    // Stellar tx hash is over the signature base (excludes signatures), so
    // the prepared unsigned envelope and the holder-signed submit share
    // the same hash — safe correlation key for activateFromBuyConfirmation.
    const pendingTxHash = Buffer.from(
      (TransactionBuilder.fromXDR(txXdr, this.networkPassphrase) as Transaction).hash()
    ).toString("hex");

    const policy: StoredPolicy = {
      id: policyId,
      onChainPolicyId: null,
      holder,
      coverageType,
      coverageTypeName: COVERAGE_NAMES[coverageType],
      coverageAmount,
      premium: premium.toString(),
      durationDays,
      expiresAt,
      status: "pending",
      isActive: false,
      createdAt: new Date().toISOString(),
      pendingTxHash,
      pendingExpiresAt: Date.now() + this.pendingTtlMs,
      triggerParams,
    };

    this.policies.set(policyId, policy);
    this.pendingByTxHash.set(pendingTxHash, policyId);

    return {
      policy,
      txXdr,
      message: "Sign and submit to activate coverage — policy stays pending until the buy_policy tx confirms",
    };
  }
}
