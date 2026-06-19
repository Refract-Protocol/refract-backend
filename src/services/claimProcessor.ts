import { EventEmitter } from "events";
import winston from "winston";

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

export enum CoverageType {
  StablecoinDepeg = 0,
  MarketCrash = 1,
  LiquidationShield = 2,
  SmartContractRisk = 3,
  FlightDelay = 4,
}

export interface Policy {
  id: string;
  holder: string;
  coverageType: CoverageType;
  coverageAmount: bigint; // 1e7 USDC
  premium: bigint;
  expiresAt: number; // unix timestamp
  triggerParams: Record<string, unknown>;
  isActive: boolean;
}

export interface OracleData {
  coverageType: CoverageType;
  value: number;
  timestamp: number;
  source: string;
}

export interface ClaimResult {
  policyId: string;
  holder: string;
  coverageType: CoverageType;
  triggered: boolean;
  payout: bigint;
  reason: string;
  processedAt: number;
}

// Trigger thresholds
const THRESHOLDS = {
  [CoverageType.StablecoinDepeg]: 0.95,       // USDC < $0.95
  [CoverageType.MarketCrash]: -0.30,           // 24h return < -30%
  [CoverageType.LiquidationShield]: 0.85,      // collateral ratio < 85%
  [CoverageType.SmartContractRisk]: 0.5e6,     // TVL drop > $500k
  [CoverageType.FlightDelay]: 120,             // delay > 120 minutes
};

export class ClaimProcessor extends EventEmitter {
  private policies: Map<string, Policy> = new Map();
  private intervalId: NodeJS.Timeout | null = null;
  private processedCount = 0;
  private payoutTotal = BigInt(0);

  constructor() {
    super();
  }

  start(intervalMs: number = 300_000): void {
    logger.info("ClaimProcessor: starting (5-min scan interval)");
    void this.scanPolicies();
    this.intervalId = setInterval(() => void this.scanPolicies(), intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Run a single scan pass and return the claims that were triggered and paid
   * out. Suitable for an externally-driven loop (see src/index.ts) as an
   * alternative to the self-scheduling `start()`.
   */
  async processTriggered(): Promise<ClaimResult[]> {
    return this.scanPolicies();
  }

  private async scanPolicies(): Promise<ClaimResult[]> {
    const now = Date.now() / 1000;
    const activePolicies = [...this.policies.values()].filter(
      p => p.isActive && p.expiresAt > now
    );

    const triggered: ClaimResult[] = [];
    if (activePolicies.length === 0) return triggered;

    logger.info(`ClaimProcessor: scanning ${activePolicies.length} active policies`);

    for (const policy of activePolicies) {
      try {
        const oracleData = await this.fetchOracleData(policy.coverageType);
        if (!oracleData) continue;

        const result = await this.evaluatePolicy(policy, oracleData);
        if (result.triggered) {
          await this.processPayout(policy, result);
          triggered.push(result);
        }
      } catch (err) {
        logger.error(`ClaimProcessor: error for policy ${policy.id}`, { err });
      }
    }

    return triggered;
  }

  private async fetchOracleData(coverageType: CoverageType): Promise<OracleData | null> {
    const now = Math.floor(Date.now() / 1000);

    // Production: fetch from Band Protocol / Pyth / AviationStack
    const mockValues: Record<CoverageType, number> = {
      [CoverageType.StablecoinDepeg]: 0.999,  // USDC price
      [CoverageType.MarketCrash]: -0.04,       // 24h market return
      [CoverageType.LiquidationShield]: 0.92,  // collateral ratio
      [CoverageType.SmartContractRisk]: 8e6,   // protocol TVL
      [CoverageType.FlightDelay]: 15,          // delay in minutes
    };

    return {
      coverageType,
      value: mockValues[coverageType],
      timestamp: now,
      source: "mock",
    };
  }

  private async evaluatePolicy(
    policy: Policy,
    oracle: OracleData
  ): Promise<ClaimResult> {
    const threshold = THRESHOLDS[policy.coverageType];
    let triggered = false;
    let reason = "";

    // Oracle staleness check: must be within 30 minutes
    const staleness = Math.floor(Date.now() / 1000) - oracle.timestamp;
    if (staleness > 1800) {
      return {
        policyId: policy.id,
        holder: policy.holder,
        coverageType: policy.coverageType,
        triggered: false,
        payout: BigInt(0),
        reason: `Oracle data stale (${staleness}s old)`,
        processedAt: Date.now(),
      };
    }

    switch (policy.coverageType) {
      case CoverageType.StablecoinDepeg:
        triggered = oracle.value < threshold;
        reason = triggered ? `USDC price ${oracle.value} < depeg threshold ${threshold}` : "No depeg detected";
        break;
      case CoverageType.MarketCrash:
        triggered = oracle.value < threshold;
        reason = triggered ? `Market crash: 24h return ${(oracle.value * 100).toFixed(1)}%` : "No crash detected";
        break;
      case CoverageType.LiquidationShield:
        triggered = oracle.value < threshold;
        reason = triggered ? `Collateral ratio ${(oracle.value * 100).toFixed(1)}% below shield threshold` : "Position healthy";
        break;
      case CoverageType.SmartContractRisk:
        triggered = oracle.value < threshold;
        reason = triggered ? `TVL drop detected: $${oracle.value.toLocaleString()}` : "TVL stable";
        break;
      case CoverageType.FlightDelay:
        triggered = oracle.value > threshold;
        reason = triggered ? `Flight delayed ${oracle.value} minutes` : `Delay ${oracle.value}m < ${threshold}m threshold`;
        break;
    }

    return {
      policyId: policy.id,
      holder: policy.holder,
      coverageType: policy.coverageType,
      triggered,
      payout: triggered ? policy.coverageAmount : BigInt(0),
      reason,
      processedAt: Date.now(),
    };
  }

  private async processPayout(policy: Policy, result: ClaimResult): Promise<void> {
    logger.info(`ClaimProcessor: PAYOUT triggered`, {
      policyId: policy.id,
      holder: policy.holder,
      payout: result.payout.toString(),
      reason: result.reason,
    });

    // Production: call pool.process_claim() on-chain via Soroban
    // await this.submitClaimTx(policy, result);

    policy.isActive = false;
    this.policies.set(policy.id, policy);
    this.processedCount++;
    this.payoutTotal += result.payout;

    this.emit("claimProcessed", result);
  }

  registerPolicy(policy: Policy): void {
    this.policies.set(policy.id, policy);
    logger.info(`ClaimProcessor: registered policy ${policy.id}`);
  }

  expirePolicy(policyId: string): void {
    this.policies.delete(policyId);
  }

  getStats() {
    return {
      activePolicies: [...this.policies.values()].filter(p => p.isActive).length,
      totalPolicies: this.policies.size,
      processedClaims: this.processedCount,
      totalPayout: this.payoutTotal.toString(),
    };
  }
}
