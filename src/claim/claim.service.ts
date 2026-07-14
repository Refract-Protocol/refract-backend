import { Injectable, Logger } from "@nestjs/common";
import { OracleReading } from "../oracle/oracle-reading";
import { OracleService } from "../oracle/oracle.service";
import { PolicyService, StoredPolicy } from "../policy/policy.service";
import { ClaimResult } from "./claim-result";

const STALENESS_LIMIT_SECONDS = 1800; // 30 minutes — matches the old ClaimProcessor

/**
 * ClaimService scans active policies for triggered conditions and settles
 * payouts. This is a migration of src/services/claimProcessor.ts, with one
 * deliberate fix: the old ClaimProcessor kept its own private
 * `Map<string, Policy>` that nothing ever populated (routes/policies.ts's
 * `POST /buy` never called `registerPolicy()`), so claim scanning never
 * actually saw a real policy. ClaimService now reads directly from
 * PolicyService, so a bought policy is immediately eligible for scanning.
 *
 * It also consolidates two previously-separate mocked "oracle" data
 * sources (OracleMonitor's websocket-feed checks vs. ClaimProcessor's own
 * private mockValues map, which used inconsistent units — e.g. MarketCrash
 * as a fraction here vs. a percentage there) into a single OracleService.
 */
@Injectable()
export class ClaimService {
  private readonly logger = new Logger(ClaimService.name);
  private processedCount = 0;
  private payoutTotal = BigInt(0);

  constructor(
    private readonly policyService: PolicyService,
    private readonly oracleService: OracleService
  ) {}

  async processTriggered(): Promise<ClaimResult[]> {
    const activePolicies = this.policyService.listActive();
    const triggered: ClaimResult[] = [];
    if (activePolicies.length === 0) return triggered;

    this.logger.log(`Scanning ${activePolicies.length} active polic${activePolicies.length === 1 ? "y" : "ies"}`);

    for (const policy of activePolicies) {
      try {
        const fetchedAt = Math.floor(Date.now() / 1000);
        const oracle = await this.fetchOracleData(policy);
        const result = this.evaluatePolicy(policy, oracle, fetchedAt);
        if (result.triggered) {
          await this.processPayout(policy, result);
          triggered.push(result);
        }
      } catch (err) {
        this.logger.error(`Error scanning policy ${policy.id}`, err instanceof Error ? err.stack : String(err));
      }
    }

    return triggered;
  }

  private async fetchOracleData(policy: StoredPolicy): Promise<OracleReading> {
    switch (policy.coverageType) {
      case 0:
        return this.oracleService.checkStablecoinDepeg();
      case 1:
        return this.oracleService.checkMarketCrash();
      case 2:
        return this.oracleService.checkLiquidationShield();
      case 3:
        return this.oracleService.checkSmartContractRisk();
      case 4:
        // TODO: PolicyService doesn't persist the buy-time triggerParams
        // (e.g. flight number) yet — same gap that existed pre-migration,
        // since routes/policies.ts accepted but silently dropped it. Wire
        // trigger_params (see schema.sql) through PolicyService once the
        // Postgres-backed repository lands, then read the real flight
        // number here.
        return this.oracleService.checkFlightDelay("UNKNOWN");
      default:
        throw new Error(`Unknown coverageType ${policy.coverageType}`);
    }
  }

  private evaluatePolicy(policy: StoredPolicy, oracle: OracleReading, fetchedAt: number): ClaimResult {
    const staleness = Math.floor(Date.now() / 1000) - fetchedAt;
    if (staleness > STALENESS_LIMIT_SECONDS) {
      return this.buildResult(policy, false, `Oracle data stale (${staleness}s old)`);
    }

    let triggered: boolean;
    switch (policy.coverageType) {
      case 4: // FlightDelay: triggers when the delay exceeds the threshold
        triggered = oracle.value > oracle.threshold;
        break;
      case 3: // SmartContractRisk: OracleService reports a 0/1 hack-detected flag
        triggered = oracle.value >= oracle.threshold;
        break;
      default: // StablecoinDepeg, MarketCrash, LiquidationShield: trigger below threshold
        triggered = oracle.value < oracle.threshold;
    }

    return this.buildResult(policy, triggered, oracle.message);
  }

  private buildResult(policy: StoredPolicy, triggered: boolean, reason: string): ClaimResult {
    return {
      policyId: policy.id,
      holder: policy.holder,
      coverageType: policy.coverageType,
      triggered,
      payout: triggered ? policy.coverageAmount : "0",
      reason,
      processedAt: Date.now(),
    };
  }

  private async processPayout(policy: StoredPolicy, result: ClaimResult): Promise<void> {
    this.logger.warn(
      `PAYOUT triggered: policy=${policy.id} holder=${policy.holder} payout=${result.payout} reason="${result.reason}"`
    );

    // TODO: build/sign/submit the pool.process_claim() Soroban transaction
    // here — tracked as a dedicated follow-up PR (real @stellar/stellar-sdk
    // transaction building, targeting testnet). Mirrors the stub that was
    // already present in the pre-migration ClaimProcessor.processPayout.

    this.policyService.deactivate(policy.id);
    this.processedCount++;
    this.payoutTotal += BigInt(result.payout);
  }

  getStats() {
    return {
      activePolicies: this.policyService.listActive().length,
      processedClaims: this.processedCount,
      totalPayout: this.payoutTotal.toString(),
    };
  }
}
