import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { rpc } from "@stellar/stellar-sdk";
import { AlertingService } from "../alerting/alerting.service";
import { AppConfig } from "../config/configuration";
import { OracleReading } from "../oracle/oracle-reading";
import { OracleService } from "../oracle/oracle.service";
import { PolicyService, StoredPolicy } from "../policy/policy.service";
import { SorobanRpcService } from "../stellar/soroban-rpc.service";
import { ClaimSettlementService } from "./claim-settlement.service";
import { ClaimResult } from "./claim-result";
import {
  SettlementAttemptRecord,
  SettlementErrorClass,
  classifySettlementError,
} from "./settlement-attempt";

const STALENESS_LIMIT_SECONDS = 1800; // 30 minutes — matches the old ClaimProcessor

export interface ScanOutcome {
  settled: ClaimResult[];
  counts: {
    scanned: number;
    triggered: number;
    settled: number;
    deferred: number;
    failedTransient: number;
    failedPermanent: number;
    failedIndeterminate: number;
    deadLettered: number;
  };
}

/**
 * ClaimService scans active policies for triggered conditions and settles
 * payouts. Settlement failures are tracked per-policy with a bounded retry
 * budget, exponential backoff, and a dead-letter path — dead-lettering never
 * deactivates the policy (payout may still be owed).
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
  /** Per-policy settlement attempt state — mirrored by settlement_attempts table. */
  private readonly attempts = new Map<string, SettlementAttemptRecord>();

  private readonly maxAttempts: number;
  private readonly maxAgeMs: number;
  private readonly backoffBaseMs: number;
  private readonly failureRateAlertThreshold: number;

  constructor(
    private readonly policyService: PolicyService,
    private readonly oracleService: OracleService,
    private readonly claimSettlementService: ClaimSettlementService,
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly alerting: AlertingService,
    private readonly rpcService: SorobanRpcService
  ) {
    const settlement = this.configService.get("settlement", { infer: true });
    this.maxAttempts = settlement.maxAttempts;
    this.maxAgeMs = settlement.maxAgeMs;
    this.backoffBaseMs = settlement.backoffBaseMs;
    this.failureRateAlertThreshold = settlement.failureRateAlertThreshold;
  }

  async processTriggered(): Promise<ClaimResult[]> {
    const outcome = await this.processTriggeredWithStats();
    return outcome.settled;
  }

  async processTriggeredWithStats(): Promise<ScanOutcome> {
    const activePolicies = this.policyService.listActive();
    const settled: ClaimResult[] = [];
    const counts: ScanOutcome["counts"] = {
      scanned: activePolicies.length,
      triggered: 0,
      settled: 0,
      deferred: 0,
      failedTransient: 0,
      failedPermanent: 0,
      failedIndeterminate: 0,
      deadLettered: 0,
    };

    if (activePolicies.length === 0) {
      return { settled, counts };
    }

    this.logger.log(`Scanning ${activePolicies.length} active polic${activePolicies.length === 1 ? "y" : "ies"}`);

    for (const policy of activePolicies) {
      try {
        const attempt = this.attempts.get(policy.id);
        if (attempt?.deadLettered) {
          continue;
        }
        if (attempt && !this.isBackoffElapsed(attempt)) {
          counts.deferred++;
          continue;
        }

        const fetchedAt = Math.floor(Date.now() / 1000);
        const oracle = await this.fetchOracleData(policy);
        const result = this.evaluatePolicy(policy, oracle, fetchedAt);
        if (result.triggered) {
          counts.triggered++;
          // Only counted/deactivated once the on-chain payout actually
          // confirms — a failed or unconfirmed settlement leaves the
          // policy active so the next scheduled scan retries it.
          // Dead-lettering stops retries but NEVER deactivates the policy.
          const settledResult = await this.processPayout(policy, result, counts);
          if (settledResult) {
            settled.push(settledResult);
            counts.settled++;
          }
        }
      } catch (err) {
        this.logger.error(`Error scanning policy ${policy.id}`, err instanceof Error ? err.stack : String(err));
      }
    }

    const failures =
      counts.failedTransient + counts.failedPermanent + counts.failedIndeterminate + counts.deadLettered;
    if (counts.triggered > 0) {
      const failureRate = failures / counts.triggered;
      if (failureRate >= this.failureRateAlertThreshold) {
        this.alerting.emit(
          "critical",
          "Settlement failure rate threshold crossed",
          `${failures}/${counts.triggered} triggered claims failed this scan (rate=${failureRate.toFixed(2)})`,
          { counts }
        );
      }
    }

    return { settled, counts };
  }

  private isBackoffElapsed(attempt: SettlementAttemptRecord): boolean {
    if (attempt.attemptCount === 0) return true;
    const delay = this.backoffBaseMs * Math.pow(2, Math.max(0, attempt.attemptCount - 1));
    return Date.now() - attempt.lastAttemptAt >= delay;
  }

  private getOrCreateAttempt(policy: StoredPolicy): SettlementAttemptRecord {
    let record = this.attempts.get(policy.id);
    if (!record) {
      record = {
        policyId: policy.id,
        holder: policy.holder,
        attemptCount: 0,
        firstAttemptAt: Date.now(),
        lastAttemptAt: 0,
        deadLettered: false,
        errorHistory: [],
      };
      this.attempts.set(policy.id, record);
    }
    return record;
  }

  private deadLetter(record: SettlementAttemptRecord, reason: string, classification: SettlementErrorClass): void {
    record.deadLettered = true;
    record.deadLetteredAt = Date.now();
    record.lastError = reason;
    record.lastErrorClass = classification;
    record.errorHistory.push({ at: Date.now(), error: reason, classification });
    this.alerting.emit(
      "critical",
      "Claim settlement dead-lettered",
      `Policy ${record.policyId} stopped retrying: ${reason}`,
      {
        policyId: record.policyId,
        holder: record.holder,
        attemptCount: record.attemptCount,
        classification,
      }
    );
  }

  /**
   * Before retrying an indeterminate (confirmation-timeout) outcome, re-query
   * the pending tx hash — it may have landed, and blindly retrying risks a
   * double payout.
   */
  private async resolveIndeterminate(record: SettlementAttemptRecord): Promise<"confirmed" | "failed" | "still_pending"> {
    if (!record.pendingTxHash) return "still_pending";
    try {
      const result = await this.rpcService.server.getTransaction(record.pendingTxHash);
      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return "confirmed";
      if (result.status === rpc.Api.GetTransactionStatus.FAILED) return "failed";
      return "still_pending";
    } catch {
      return "still_pending";
    }
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
      case 4: {
        const flightNumber = policy.triggerParams?.flightNumber;
        return this.oracleService.checkFlightDelay(typeof flightNumber === "string" ? flightNumber : "UNKNOWN");
      }
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
    counts: ScanOutcome["counts"]
  ): Promise<ClaimResult | undefined> {
    this.logger.warn(
      `PAYOUT triggered: policy=${policy.id} holder=${policy.holder} payout=${result.payout} reason="${result.reason}"`
    );

    const record = this.getOrCreateAttempt(policy);

    // Indeterminate prior attempt: re-query before any new submission.
    if (record.lastErrorClass === "indeterminate" && record.pendingTxHash) {
      const resolution = await this.resolveIndeterminate(record);
      if (resolution === "confirmed") {
        this.logger.log(`Prior settlement tx ${record.pendingTxHash} confirmed on re-query for ${policy.id}`);
        this.policyService.deactivate(policy.id);
        this.processedCount++;
        this.payoutTotal += BigInt(result.payout);
        const settledResult = { ...result, settlementTxHash: record.pendingTxHash };
        this.history.push(settledResult);
        this.attempts.delete(policy.id);
        return settledResult;
      }
      if (resolution === "still_pending") {
        counts.failedIndeterminate++;
        counts.deferred++;
        return undefined;
      }
      // failed on-chain — clear pending hash and continue to a fresh attempt
      record.pendingTxHash = undefined;
    }

    if (!policy.onChainPolicyId) {
      const err = "permanent: missing on-chain policy id (buy_policy return value never recorded)";
      this.recordFailure(record, err, "permanent", counts);
      return undefined;
    }

    let onChainId: bigint;
    try {
      onChainId = BigInt(policy.onChainPolicyId);
    } catch {
      const err = "permanent: on-chain policy id is not a valid u64";
      this.recordFailure(record, err, "permanent", counts);
      return undefined;
    }

    const settlement = await this.claimSettlementService.settleClaim(onChainId, policy.holder, BigInt(result.payout));
    if (!settlement.settled) {
      const classification = classifySettlementError(settlement.error);
      if (classification === "indeterminate" && settlement.txHash) {
        record.pendingTxHash = settlement.txHash;
      }
      this.recordFailure(record, settlement.error ?? "Settlement did not confirm", classification, counts);
      return undefined;
    }

    this.logger.log(`Settlement confirmed for policy ${policy.id}: tx=${settlement.txHash}`);
    this.policyService.deactivate(policy.id);
    this.processedCount++;
    this.payoutTotal += BigInt(result.payout);
    const settledResult = { ...result, settlementTxHash: settlement.txHash };
    this.history.push(settledResult);
    this.attempts.delete(policy.id);
    return settledResult;
  }

  private recordFailure(
    record: SettlementAttemptRecord,
    error: string,
    classification: SettlementErrorClass,
    counts: ScanOutcome["counts"]
  ): void {
    const now = Date.now();
    if (record.attemptCount === 0) record.firstAttemptAt = now;
    record.attemptCount++;
    record.lastAttemptAt = now;
    record.lastError = error;
    record.lastErrorClass = classification;
    record.errorHistory.push({ at: now, error, classification });

    this.logger.error(
      `Settlement did not confirm for policy ${record.policyId} ` +
        `(attempt ${record.attemptCount}/${this.maxAttempts}, class=${classification}): ${error}`
    );

    if (classification === "permanent") {
      counts.failedPermanent++;
      counts.deadLettered++;
      this.deadLetter(record, error, classification);
      return;
    }

    if (classification === "indeterminate") counts.failedIndeterminate++;
    else counts.failedTransient++;

    const agedOut = now - record.firstAttemptAt >= this.maxAgeMs;
    const budgetExhausted = record.attemptCount >= this.maxAttempts;
    if (agedOut || budgetExhausted) {
      counts.deadLettered++;
      this.deadLetter(
        record,
        budgetExhausted
          ? `Retry budget exhausted (${record.attemptCount} attempts): ${error}`
          : `Max settlement age exceeded: ${error}`,
        classification
      );
    }
  }

  getStats() {
    const deadLettered = [...this.attempts.values()].filter((a) => a.deadLettered).length;
    return {
      activePolicies: this.policyService.listActive().length,
      processedClaims: this.processedCount,
      totalPayout: this.payoutTotal.toString(),
      // Surfaces whether ClaimSettlementService actually has a pool
      // contract ID + relayer secret configured, so ops can tell from the
      // API whether triggered claims will settle on-chain or just log a
      // "not configured" error, without digging through env/logs.
      settlementConfigured: this.claimSettlementService.isConfigured(),
      deadLetteredClaims: deadLettered,
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

  listDeadLettered(): SettlementAttemptRecord[] {
    return [...this.attempts.values()].filter((a) => a.deadLettered);
  }

  getAttempt(policyId: string): SettlementAttemptRecord | undefined {
    return this.attempts.get(policyId);
  }

  /** Manual requeue from ops — clears dead-letter flag and resets backoff clock. */
  requeueDeadLetter(policyId: string): SettlementAttemptRecord {
    const record = this.attempts.get(policyId);
    if (!record || !record.deadLettered) {
      throw new NotFoundException({ error: `No dead-lettered claim for policy ${policyId}` });
    }
    record.deadLettered = false;
    record.deadLetteredAt = undefined;
    record.attemptCount = 0;
    record.lastAttemptAt = 0;
    record.firstAttemptAt = Date.now();
    record.pendingTxHash = undefined;
    record.errorHistory.push({
      at: Date.now(),
      error: "Manually requeued by ops",
      classification: "transient",
    });
    this.logger.warn(`Dead-lettered claim for policy ${policyId} requeued by ops`);
    return record;
  }
}
