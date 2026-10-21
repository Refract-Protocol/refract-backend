import { Injectable, Logger } from "@nestjs/common";
import { OracleEventRepository } from "../oracle/oracle-event.repository";
import { OracleReading } from "../oracle/oracle-reading";
import { OracleService } from "../oracle/oracle.service";
import { PolicyService, StoredPolicy } from "../policy/policy.service";
import { ClaimSettlementService } from "./claim-settlement.service";
import { ClaimResult } from "./claim-result";
import {
  TriggerDirection,
  TriggerStabilityEvaluator,
  defaultTriggerConfig,
  triggerOverridesFromEnv,
} from "./trigger/trigger-stability";

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
  // In-memory settlement history — same lifetime/limitations as
  // PolicyService's in-memory store; replaced together once the
  // Postgres-backed repository lands.
  private readonly history: ClaimResult[] = [];
  // Debounces each policy's threshold check (hysteresis, minimum dwell,
  // flap damping) so a value hovering around the threshold can't toggle
  // the coverage condition on every scan. Keyed by policy id.
  private readonly triggerOverrides = triggerOverridesFromEnv(process.env);
  private readonly policyCoverageTypes = new Map<string, number>();
  private readonly triggerEvaluator = new TriggerStabilityEvaluator((policyId) =>
    defaultTriggerConfig(this.policyCoverageTypes.get(policyId) ?? -1, this.triggerOverrides)
  );

  constructor(
    private readonly policyService: PolicyService,
    private readonly oracleService: OracleService,
    private readonly claimSettlementService: ClaimSettlementService,
    private readonly oracleEventRepository: OracleEventRepository
  ) {
    this.triggerEvaluator.onTransition((e) => {
      const line =
        `Trigger ${e.kind} policy=${e.key} ${e.from} -> ${e.to} value=${e.evidence.value} ` +
        `threshold=${e.evidence.threshold} band=${e.evidence.hysteresis} penalty=${Math.round(e.evidence.penalty)} ` +
        `flips=${e.evidence.flips}: ${e.evidence.reason}`;
      // Suppressed changes are an alerting signal (a feed sitting on a payout boundary), not routine.
      if (e.kind === "suppressed") this.logger.warn(line);
      else this.logger.log(line);
    });
  }


  async processTriggered(): Promise<ClaimResult[]> {
    const activePolicies = this.policyService.listActive();
    const settled: ClaimResult[] = [];
    if (activePolicies.length === 0) return settled;

    this.logger.log(`Scanning ${activePolicies.length} active polic${activePolicies.length === 1 ? "y" : "ies"}`);

    for (const policy of activePolicies) {
      try {
        const fetchedAt = Math.floor(Date.now() / 1000);
        const oracle = await this.fetchOracleData(policy);
        const result = this.evaluatePolicy(policy, oracle, fetchedAt);
        if (result.triggered) {
          // Only counted/deactivated once the on-chain payout actually
          // confirms — a failed or unconfirmed settlement leaves the
          // policy active so the next scheduled scan retries it.
          const settledResult = await this.processPayout(policy, result);
          if (settledResult) settled.push(settledResult);
        }
      } catch (err) {
        this.logger.error(`Error scanning policy ${policy.id}`, err instanceof Error ? err.stack : String(err));
      }
    }

    return settled;
  }

  private async fetchOracleData(policy: StoredPolicy): Promise<OracleReading> {
    let reading: OracleReading;
    switch (policy.coverageType) {
      case 0:
        reading = await this.oracleService.checkStablecoinDepeg();
        break;
      case 1:
        reading = await this.oracleService.checkMarketCrash();
        break;
      case 2:
        reading = await this.oracleService.checkLiquidationShield();
        break;
      case 3:
        reading = await this.oracleService.checkSmartContractRisk();
        break;
      case 4: {
        const flightNumber = policy.triggerParams?.flightNumber;
        reading = await this.oracleService.checkFlightDelay(
          typeof flightNumber === "string" ? flightNumber : "UNKNOWN"
        );
        break;
      }
      default:
        throw new Error(`Unknown coverageType ${policy.coverageType}`);
    }

    // Persist every claim-evaluation reading — fire-and-forget so a DB
    // hiccup never disrupts the evaluation path.
    void this.oracleEventRepository.record(reading);

    return reading;
  }

  private evaluatePolicy(policy: StoredPolicy, oracle: OracleReading, fetchedAt: number): ClaimResult {
    const staleness = Math.floor(Date.now() / 1000) - fetchedAt;
    if (staleness > STALENESS_LIMIT_SECONDS) {
      return this.buildResult(policy, false, `Oracle data stale (${staleness}s old)`);
    }

    // FlightDelay triggers when the delay exceeds the threshold; every other
    // coverage type triggers below it.
    const direction: TriggerDirection = policy.coverageType === 4 ? "above" : "below";
    this.policyCoverageTypes.set(policy.id, policy.coverageType);
    const decision = this.triggerEvaluator.evaluate(policy.id, {
      value: oracle.value,
      threshold: oracle.threshold,
      direction,
      observedAt: fetchedAt * 1000,
    });

    const result = this.buildResult(policy, decision.triggered, `${oracle.message} [trigger: ${decision.reason}]`);
    if (decision.triggered && decision.confirmedAt !== null) {
      result.triggerDetectedAt = decision.confirmedAt;
    }
    return result;
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

  /** Returns the settled ClaimResult, or undefined if settlement didn't confirm. */
  private async processPayout(policy: StoredPolicy, result: ClaimResult): Promise<ClaimResult | undefined> {
    this.logger.warn(
      `PAYOUT triggered: policy=${policy.id} holder=${policy.holder} payout=${result.payout} reason="${result.reason}"`
    );

    const settlement = await this.claimSettlementService.settleClaim(policy.id, policy.holder, BigInt(result.payout));
    if (!settlement.settled) {
      this.logger.error(`Settlement did not confirm for policy ${policy.id}, will retry next scan: ${settlement.error}`);
      return undefined;
    }

    this.logger.log(`Settlement confirmed for policy ${policy.id}: tx=${settlement.txHash}`);
    this.policyService.deactivate(policy.id);
    this.triggerEvaluator.forget(policy.id);
    this.policyCoverageTypes.delete(policy.id);
    this.processedCount++;
    this.payoutTotal += BigInt(result.payout);
    const settledResult = { ...result, settlementTxHash: settlement.txHash };
    this.history.push(settledResult);
    return settledResult;
  }

  getStats() {
    return {
      activePolicies: this.policyService.listActive().length,
      processedClaims: this.processedCount,
      totalPayout: this.payoutTotal.toString(),
      // Surfaces whether ClaimSettlementService actually has a pool
      // contract ID + relayer secret configured, so ops can tell from the
      // API whether triggered claims will settle on-chain or just log a
      // "not configured" error, without digging through env/logs.
      settlementConfigured: this.claimSettlementService.isConfigured(),
    };
  }

  /** Settled claim history for a holder, most recent first. */
  getHistoryForHolder(address: string): ClaimResult[] {
    return this.history.filter((claim) => claim.holder === address).sort((a, b) => b.processedAt - a.processedAt);
  }

  /** Most recent settled claims across all holders, for public "recent activity" displays. */
  getRecentSettlements(limit = 10): ClaimResult[] {
    return [...this.history].sort((a, b) => b.processedAt - a.processedAt).slice(0, limit);
  }
}
