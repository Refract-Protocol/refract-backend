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
import { v4 as uuidv4 } from "uuid";
import { AppConfig } from "../config/configuration";
import { BuyPolicyDto } from "./dto/buy-policy.dto";

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
  triggerParams?: Record<string, unknown>;
}

/**
 * Minimal structural surface of a `pg` Pool/Client used by PolicyRepository.
 * Kept as an interface so tests can inject a fake without pulling in `pg`
 * types, and so the shared connection-pool module (separate issue) can be
 * wired in later without touching this file's call sites.
 */
export interface PolicyQueryable {
  query<R = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

interface PolicyRow {
  id: string;
  holder: string;
  coverage_type: number;
  coverage_type_name: string;
  coverage_amount: string;
  premium: string;
  duration_days: number;
  expires_at: string | number;
  is_active: boolean;
  created_at: string | Date;
  trigger_params: Record<string, unknown> | null;
}

/**
 * Postgres-backed store for `policies` (see src/db/schema.sql). Monetary
 * columns are NUMERIC(30,0); `pg` returns NUMERIC as a string, which we
 * convert to BigInt for the service layer and back on write — no float ever
 * touches these values, so precision is preserved exactly.
 */
export class PolicyRepository {
  constructor(private readonly db: PolicyQueryable) {}

  private toStoredPolicy(row: PolicyRow): StoredPolicy {
    return {
      id: row.id,
      holder: row.holder,
      coverageType: row.coverage_type,
      coverageTypeName: row.coverage_type_name,
      coverageAmount: BigInt(row.coverage_amount).toString(),
      premium: BigInt(row.premium).toString(),
      durationDays: row.duration_days,
      expiresAt: Number(row.expires_at),
      isActive: row.is_active,
      createdAt:
        row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      triggerParams: row.trigger_params ?? undefined,
    };
  }

  async insert(policy: StoredPolicy): Promise<StoredPolicy> {
    const { rows } = await this.db.query<PolicyRow>(
      `INSERT INTO policies (
         id, holder, coverage_type, coverage_type_name, coverage_amount,
         premium, duration_days, expires_at, is_active, created_at, trigger_params
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        policy.id,
        policy.holder,
        policy.coverageType,
        policy.coverageTypeName,
        BigInt(policy.coverageAmount).toString(),
        BigInt(policy.premium).toString(),
        policy.durationDays,
        policy.expiresAt,
        policy.isActive,
        policy.createdAt,
        policy.triggerParams ?? null,
      ]
    );
    return this.toStoredPolicy(rows[0]);
  }

  async findById(id: string): Promise<StoredPolicy | null> {
    const { rows } = await this.db.query<PolicyRow>(
      `SELECT * FROM policies WHERE id = $1`,
      [id]
    );
    return rows.length > 0 ? this.toStoredPolicy(rows[0]) : null;
  }

  async findByHolder(holder: string): Promise<StoredPolicy[]> {
    const { rows } = await this.db.query<PolicyRow>(
      `SELECT * FROM policies WHERE holder = $1 ORDER BY created_at DESC`,
      [holder]
    );
    return rows.map((row) => this.toStoredPolicy(row));
  }

  async listActive(): Promise<StoredPolicy[]> {
    const { rows } = await this.db.query<PolicyRow>(
      `SELECT * FROM policies WHERE is_active = true ORDER BY created_at DESC`
    );
    return rows.map((row) => this.toStoredPolicy(row));
  }

  /**
   * Conditional update so concurrent deactivations can't lose updates: only
   * the caller whose UPDATE matches an active row reports success.
   */
  async deactivate(id: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE policies SET is_active = false WHERE id = $1 AND is_active = true`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }
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
  // Postgres-backed store (src/db/schema.sql's `policies` table). The
  // repository is injected so tests can supply a fake; production wiring
  // passes the shared pg pool.
  private readonly repository: PolicyRepository;

  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly poolContractId: string;

  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    repository?: PolicyRepository
  ) {
    const stellar = this.configService.get("stellar", { infer: true });
    this.server = new rpc.Server(stellar.sorobanRpcUrl);
    this.networkPassphrase = stellar.networkPassphrase;
    this.poolContractId = stellar.poolContractId;
    this.repository = repository ?? new PolicyRepository(this.createDefaultQueryable());
  }

  /**
   * Fallback queryable used when no repository is injected (e.g. legacy
   * construction sites). Lazily requires `pg` so the module still loads in
   * environments without a configured database.
   */
  private createDefaultQueryable(): PolicyQueryable {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Pool } = require("pg") as typeof import("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    return {
      query: (text: string, values?: unknown[]) => pool.query(text, values),
    };
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
      const contract = new Contract(this.poolContractId);
      const operation = contract.call("pool_config");
      const sourceAccount = new Account(Keypair.random().publicKey(), "0");
      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const simulation = await this.server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(simulation) || !simulation.result) {
        return null;
      }
      const native = scValToNative(simulation.result.retval) as
        | { min_coverage?: bigint; max_coverage?: bigint }
        | null;
      if (!native || native.min_coverage === undefined || native.max_coverage === undefined) {
        return null;
      }
      return { minCoverage: native.min_coverage, maxCoverage: native.max_coverage };
    } catch {
      return null;
    }
  }

  getCoverageTypes(): CoverageTypeCatalogEntry[] {
    return COVERAGE_TYPES;
  }

  /**
   * Builds the unsigned buy_policy() transaction for a holder. The policy
   * row itself is persisted by the caller (buy()) once the transaction is
   * prepared, so the repository stays the single source of truth.
   */
  async buildBuyTransaction(dto: BuyPolicyDto): Promise<{ xdr: string; policy: StoredPolicy }> {
    const coverageType = dto.coverageType;
    const coverageAmount = BigInt(dto.coverageAmount);
    const durationDays = dto.durationDays;
    const triggerThreshold = TRIGGER_THRESHOLDS[coverageType];

    const paramsScVal = this.buildPolicyParamsScVal(
      coverageType,
      coverageAmount,
      durationDays,
      triggerThreshold
    );
    const xdrString = await this.buildUnsignedBuyInvoke(dto.holder, paramsScVal);

    const premium = this.calculatePremium(coverageAmount, coverageType, durationDays);
    const now = Date.now();
    const policy: StoredPolicy = {
      id: uuidv4(),
      holder: dto.holder,
      coverageType,
      coverageTypeName: COVERAGE_NAMES[coverageType],
      coverageAmount: coverageAmount.toString(),
      premium: premium.toString(),
      durationDays,
      expiresAt: now + durationDays * 24 * 60 * 60 * 1000,
      isActive: true,
      createdAt: new Date(now).toISOString(),
      triggerParams: dto.triggerParams,
    };

    return { xdr: xdrString, policy };
  }

  /**
   * Persists a bought policy. Kept separate from buildBuyTransaction so the
   * service can insert only after the holder has signed and submitted.
   */
  async save(policy: StoredPolicy): Promise<StoredPolicy> {
    return this.repository.insert(policy);
  }

  async buy(dto: BuyPolicyDto): Promise<{ xdr: string; policy: StoredPolicy }> {
    const { xdr: xdrString, policy } = await this.buildBuyTransaction(dto);
    const stored = await this.repository.insert(policy);
    return { xdr: xdrString, policy: stored };
  }

  async findById(id: string): Promise<StoredPolicy | null> {
    return this.repository.findById(id);
  }

  async findByHolder(holder: string): Promise<StoredPolicy[]> {
    return this.repository.findByHolder(holder);
  }

  async listActive(): Promise<StoredPolicy[]> {
    return this.repository.listActive();
  }

  async deactivate(id: string): Promise<boolean> {
    return this.repository.deactivate(id);
  }

  private calculatePremium(
    coverageAmount: bigint,
    coverageType: number,
    durationDays: number
  ): bigint {
    const riskMultiplier = RISK_MULTIPLIERS[coverageType] ?? 1.0;
    const annualRate = (BASE_RATE_BPS / 10_000) * riskMultiplier;
    const termFraction = durationDays / 365;
    // Scale to basis points before applying the fractional rate so the
    // result stays integer-only (no float precision loss on BigInt).
    const premiumBps = BigInt(Math.round(annualRate * termFraction * 10_000));
    return (coverageAmount * premiumBps) / 10_000n;
  }
}
