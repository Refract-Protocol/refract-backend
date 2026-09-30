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
import {
  COVERAGE_TYPE_CODE,
  COVERAGE_TYPE_LABEL,
  COVERAGE_TYPE_RISK_MULTIPLIER,
  COVERAGE_TYPE_TRIGGER_THRESHOLD,
  codeToSoroban,
} from "../common/coverage-type.map";
import { BuyPolicyDto } from "./dto/buy-policy.dto";
import { PolicyRepository } from "./policy.repository";

const FLIGHT_DELAY_COVERAGE_TYPE = COVERAGE_TYPE_CODE.FlightDelay;

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

const BASE_RATE_BPS = 300; // 3% annual

const COVERAGE_TYPES: CoverageTypeCatalogEntry[] = [
  {
    id: COVERAGE_TYPE_CODE.StablecoinDepeg,
    name: COVERAGE_TYPE_LABEL.StablecoinDepeg,
    description: "Pays out if a major stablecoin depegs below $0.95",
    riskLevel: "medium",
    riskMultiplier: COVERAGE_TYPE_RISK_MULTIPLIER.StablecoinDepeg,
    baseRatePct: 3.0,
    maxCoverage: 100_000,
    trigger: "USDC price < $0.95 for 15+ minutes",
    icon: "🪙",
  },
  {
    id: COVERAGE_TYPE_CODE.MarketCrash,
    name: COVERAGE_TYPE_LABEL.MarketCrash,
    description: "Covers catastrophic market downturns exceeding 30% in 24h",
    riskLevel: "high",
    riskMultiplier: COVERAGE_TYPE_RISK_MULTIPLIER.MarketCrash,
    baseRatePct: 4.5,
    maxCoverage: 50_000,
    trigger: "Market index 24h return < -30%",
    icon: "📉",
  },
  {
    id: COVERAGE_TYPE_CODE.LiquidationShield,
    name: COVERAGE_TYPE_LABEL.LiquidationShield,
    description: "Pays out if your DeFi position gets liquidated",
    riskLevel: "high",
    riskMultiplier: COVERAGE_TYPE_RISK_MULTIPLIER.LiquidationShield,
    baseRatePct: 6.0,
    maxCoverage: 200_000,
    trigger: "Collateral ratio drops below maintenance threshold",
    icon: "🛡️",
  },
  {
    id: COVERAGE_TYPE_CODE.SmartContractRisk,
    name: COVERAGE_TYPE_LABEL.SmartContractRisk,
    description: "Protection against smart contract exploits and hacks",
    riskLevel: "critical",
    riskMultiplier: COVERAGE_TYPE_RISK_MULTIPLIER.SmartContractRisk,
    baseRatePct: 9.0,
    maxCoverage: 500_000,
    trigger: "Covered protocol TVL drops >50% in <1 hour",
    icon: "🔐",
  },
  {
    id: COVERAGE_TYPE_CODE.FlightDelay,
    name: COVERAGE_TYPE_LABEL.FlightDelay,
    description: "Automatic payout for flight delays over 2 hours",
    riskLevel: "low",
    riskMultiplier: COVERAGE_TYPE_RISK_MULTIPLIER.FlightDelay,
    baseRatePct: 2.4,
    maxCoverage: 2_000,
    trigger: "Flight delayed > 120 minutes per AviationStack data",
    icon: "✈️",
  },
];

@Injectable()
export class PolicyService {
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly poolContractId: string;

  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly policyRepository: PolicyRepository
  ) {
    const stellar = this.configService.get("stellar", { infer: true });
    this.server = new rpc.Server(stellar.sorobanRpcUrl);
    this.networkPassphrase = stellar.networkPassphrase;
    this.poolContractId = stellar.poolContractId;
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
        val: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(codeToSoroban(coverageType))]),
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
    return COVERAGE_TYPES.map(
      ({ id, name, description, riskLevel, riskMultiplier, baseRatePct, maxCoverage, trigger, icon }) => ({
        id,
        name,
        description,
        riskLevel,
        riskMultiplier,
        baseRatePct,
        maxCoverage,
        trigger,
        icon,
      })
    );
  }

  findByHolder(address: string): Promise<StoredPolicy[]> {
    return this.policyRepository.findByHolder(address);
  }

  findById(id: string): Promise<StoredPolicy | undefined> {
    return this.policyRepository.findById(id);
  }

  /** Active, unexpired policies — the pool ClaimService scans for triggers. */
  listActive(): Promise<StoredPolicy[]> {
    return this.policyRepository.listActive();
  }

  /**
   * Policies whose expiresAt is in the past but whose isActive flag is still
   * true — silently excluded from listActive() scans but still visible in
   * findByHolder().  Exposed for the ReconciliationService drift check.
   */
  getExpiredActive(): StoredPolicy[] {
    const now = Math.floor(Date.now() / 1000);
    return [...this.policies.values()].filter((p) => p.isActive && p.expiresAt <= now);
  }

  /** Marks a policy inactive after a claim has been paid out. */
  deactivate(id: string): Promise<void> {
    return this.policyRepository.deactivate(id);
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
    const catalogEntry = COVERAGE_TYPES[coverageType];
    const maxCoverage = catalogEntry.maxCoverage;
    if (coverage > BigInt(maxCoverage) * 10_000_000n) {
      throw new BadRequestException({
        error: `coverageAmount exceeds the ${COVERAGE_TYPE_LABEL[codeToSoroban(coverageType)]} maximum of ${maxCoverage} USDC`,
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

    const multiplier = COVERAGE_TYPE_RISK_MULTIPLIER[codeToSoroban(coverageType)];
    const annualRate = (BASE_RATE_BPS / 10_000) * multiplier; // bps -> fraction, e.g. 300bps * 1.0 = 0.03 (3%)
    const dailyRate = annualRate / 365;
    const premiumFraction = dailyRate * durationDays;
    const premium = BigInt(Math.floor(Number(coverage) * premiumFraction));

    const policyId = uuidv4();
    const expiresAt = Math.floor(Date.now() / 1000) + durationDays * 86400;

    const policy: StoredPolicy = {
      id: policyId,
      holder,
      coverageType,
      coverageTypeName: COVERAGE_TYPE_LABEL[codeToSoroban(coverageType)],
      coverageAmount,
      premium: premium.toString(),
      durationDays,
      expiresAt,
      isActive: true,
      createdAt: new Date().toISOString(),
      triggerParams,
    };

    await this.policyRepository.insert(policy);

    const paramsScVal = this.buildPolicyParamsScVal(
      coverageType,
      coverage,
      durationDays,
      COVERAGE_TYPE_TRIGGER_THRESHOLD[codeToSoroban(coverageType)]
    );
    const txXdr = await this.buildUnsignedBuyInvoke(holder, paramsScVal);

    return {
      policy,
      txXdr,
      message: "Sign and submit to activate coverage",
    };
  }
}
