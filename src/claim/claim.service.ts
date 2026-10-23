import { Injectable, Logger } from "@nestjs/common";
import { OracleEventRepository } from "../oracle/oracle-event.repository";
import { OracleReading } from "../oracle/oracle-reading";
import { buildDecisionId } from "../oracle/oracle-encoding";
import { OracleService } from "../oracle/oracle.service";
import { PolicyService, StoredPolicy } from "../policy/policy.service";
import { ClaimSettlementRepository } from "./claim-settlement.repository";
import { ClaimSettlementService } from "./claim-settlement.service";
import { ClaimResult } from "./claim-result";
import { classifySettlementError } from "./settlement-attempt";

const STALENESS_LIMIT_SECONDS = 1800; // 30 minutes — matches the old ClaimProcessor
// Decisions are keyed per fixed window so every node derives the same id for the
// same observation; matches the 300 s ClaimScheduler cadence.
const DECISION_WINDOW_SECONDS = 300;

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

  constructor(
    private readonly policyService: PolicyService,
    private readonly oracleService: OracleService,
    private readonly claimSettlementService: ClaimSettlementService,
    private readonly oracleEventRepository: OracleEventRepository,
    private readonly claimSettlementRepository: ClaimSettlementRepository
  ) {}

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
          const windowStart = Math.floor(fetchedAt / DECISION_WINDOW_SECONDS) * DECISION_WINDOW_SECONDS;
          const decisionId = buildDecisionId(oracle.coverageType, policy.id, windowStart);
          // Only counted/deactivated once the on-chain payout actually
          // confirms — a failed or unconfirmed settlement leaves the
          // policy active so the next scheduled scan retries it.
          const settledResult = await this.processPayout(policy, result, decisionId);
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

    let triggered: boolean;
    switch (policy.coverageType) {
      case 4: // FlightDelay: triggers when the delay exceeds the threshold
        triggered = oracle.value > oracle.threshold;
        break;
      default: // StablecoinDepeg, MarketCrash, LiquidationShield, SmartContractRisk: trigger below threshold
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

  /** Returns the settled ClaimResult, or undefined if settlement didn't confirm. */
  private async processPayout(
    policy: StoredPolicy,
    result: ClaimResult,
    decisionId: string
  ): Promise<ClaimResult | undefined> {
    this.logger.warn(
      `PAYOUT triggered: policy=${policy.id} decision=${decisionId} holder=${policy.holder} payout=${result.payout} reason="${result.reason}"`
    );

    // Durable guard before any on-chain submission: a replayed or concurrent
    // decision for the same policy/window (or any open settlement for the
    // policy) is a no-op.
    const claimed = await this.claimSettlementRepository.claim(decisionId, policy.id, result.payout, {
      reason: result.reason,
    });
    if (!claimed) {
      this.logger.warn(`Duplicate settlement suppressed: decision=${decisionId} policy=${policy.id}`);
      return undefined;
    }

    const settlement = await this.claimSettlementService.settleClaim(policy.id, policy.holder, BigInt(result.payout));
    if (!settlement.settled) {
      if (classifySettlementError(settlement.error) === "indeterminate") {
        // The transaction may have landed. Leave the row open so it is
        // reconciled against tx_hash instead of being resubmitted.
        this.logger.error(
          `Settlement outcome unknown for decision=${decisionId} policy=${policy.id}; not retrying until reconciled: ${settlement.error}`
        );
      } else {
        await this.claimSettlementRepository.markFailed(decisionId, settlement.error ?? "unknown error");
        this.logger.error(`Settlement did not confirm for policy ${policy.id}, will retry next scan: ${settlement.error}`);
      }
      return undefined;
    }

    await this.claimSettlementRepository.markConfirmed(decisionId, policy.id, settlement.txHash ?? "");
    this.logger.log(`Settlement confirmed for policy ${policy.id}: decision=${decisionId} tx=${settlement.txHash}`);
    this.policyService.deactivate(policy.id);
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
