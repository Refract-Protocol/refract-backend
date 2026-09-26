import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { OracleReading } from "../oracle/oracle-reading";
import { OracleService } from "../oracle/oracle.service";
import { PolicyService, StoredPolicy } from "../policy/policy.service";
import { ClaimSettlementService } from "./claim-settlement.service";
import { ClaimResult, ClaimScanStats, PayoutDiscrepancyRecord } from "./claim-result";
import { mapWithConcurrency, SerialQueue } from "./concurrency.util";

const STALENESS_LIMIT_SECONDS = 1800; // 30 minutes — matches the old ClaimProcessor

interface TimedOracleReading {
  reading: OracleReading;
  fetchedAt: number;
}

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
 *
 * Scan pipeline (issue #37):
 *  1. High-concurrency read/evaluate stage (oracle fetch + evaluatePolicy)
 *     with shared readings per coverage type and CLAIM_SCAN_CONCURRENCY.
 *  2. Serial settle stage via SerialQueue so one relayer account never
 *     collides on sequence numbers.
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
  private readonly discrepancies: PayoutDiscrepancyRecord[] = [];
  private readonly settleQueue = new SerialQueue();
  private scanInFlight = false;
  private lastScanStats: ClaimScanStats | null = null;

  constructor(
    private readonly policyService: PolicyService,
    private readonly oracleService: OracleService,
    private readonly claimSettlementService: ClaimSettlementService,
    private readonly configService: ConfigService<AppConfig, true>
  ) {}

  /**
   * Returns false (and skips work) when a previous scan is still running —
   * overlapping @Interval ticks must not double the load.
   */
  tryBeginScan(): boolean {
    if (this.scanInFlight) {
      this.logger.warn("Claim scan still running; skipping overlapping interval");
      return false;
    }
    this.scanInFlight = true;
    return true;
  }

  endScan(): void {
    this.scanInFlight = false;
  }

  isScanInFlight(): boolean {
    return this.scanInFlight;
  }

  getLastScanStats(): ClaimScanStats | null {
    return this.lastScanStats;
  }

  getPayoutDiscrepancies(): readonly PayoutDiscrepancyRecord[] {
    return this.discrepancies;
  }

  async processTriggered(): Promise<ClaimResult[]> {
    const started = Date.now();
    const activePolicies = this.policyService.listActive();
    const settled: ClaimResult[] = [];
    let triggeredCount = 0;
    let failedCount = 0;

    if (activePolicies.length === 0) {
      this.lastScanStats = {
        policiesExamined: 0,
        triggered: 0,
        settled: 0,
        failed: 0,
        durationMs: Date.now() - started,
      };
      return settled;
    }

    this.logger.log(`Scanning ${activePolicies.length} active polic${activePolicies.length === 1 ? "y" : "ies"}`);

    const claimsConfig = this.configService.get("claims", { infer: true });
    const concurrency = claimsConfig.scanConcurrency;
    const mismatchTolerance = BigInt(claimsConfig.payoutMismatchTolerance);

    // Shared oracle readings keyed by coverage type (flight delay also keys
    // on flight number so distinct flights don't share a reading).
    const readingCache = new Map<string, Promise<TimedOracleReading>>();

    const results = await mapWithConcurrency(activePolicies, concurrency, async (policy) => {
      const oracle = await this.fetchOracleDataCached(policy, readingCache);
      const result = this.evaluatePolicy(policy, oracle.reading, oracle.fetchedAt);
      if (!result.triggered) {
        return { kind: "not_triggered" as const };
      }
      // Settlement is serialized per relayer account even while oracle
      // fetches ran in parallel.
      const settledResult = await this.settleQueue.enqueue(() =>
        this.processPayout(policy, result, mismatchTolerance)
      );
      if (settledResult) {
        return { kind: "settled" as const, result: settledResult };
      }
      return { kind: "settle_failed" as const };
    });

    for (const outcome of results) {
      if (outcome.status === "rejected") {
        failedCount++;
        this.logger.error(
          `Error scanning policy`,
          outcome.reason instanceof Error ? outcome.reason.stack : String(outcome.reason)
        );
        continue;
      }
      if (outcome.value.kind === "settled" || outcome.value.kind === "settle_failed") {
        triggeredCount++;
      }
      if (outcome.value.kind === "settled") {
        settled.push(outcome.value.result);
      } else if (outcome.value.kind === "settle_failed") {
        failedCount++;
      }
    }

    this.lastScanStats = {
      policiesExamined: activePolicies.length,
      triggered: triggeredCount,
      settled: settled.length,
      failed: failedCount,
      durationMs: Date.now() - started,
    };
    this.logger.log(
      `Claim scan complete examined=${this.lastScanStats.policiesExamined} triggered=${this.lastScanStats.triggered} settled=${this.lastScanStats.settled} failed=${this.lastScanStats.failed} durationMs=${this.lastScanStats.durationMs}`
    );

    return settled;
  }

  private fetchOracleDataCached(
    policy: StoredPolicy,
    cache: Map<string, Promise<TimedOracleReading>>
  ): Promise<TimedOracleReading> {
    const cacheKey =
      policy.coverageType === 4
        ? `4:${typeof policy.triggerParams?.flightNumber === "string" ? policy.triggerParams.flightNumber : "UNKNOWN"}`
        : String(policy.coverageType);

    let pending = cache.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        const fetchedAt = Math.floor(Date.now() / 1000);
        const reading = await this.fetchOracleData(policy);
        return { reading, fetchedAt };
      })();
      cache.set(cacheKey, pending);
    }
    return pending;
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
    const expected = triggered ? policy.coverageAmount : "0";
    return {
      policyId: policy.id,
      holder: policy.holder,
      coverageType: policy.coverageType,
      triggered,
      payout: expected,
      expectedPayout: expected,
      reason,
      processedAt: Date.now(),
    };
  }

  /** Returns the settled ClaimResult, or undefined if settlement didn't confirm. */
  private async processPayout(
    policy: StoredPolicy,
    result: ClaimResult,
    mismatchTolerance: bigint
  ): Promise<ClaimResult | undefined> {
    this.logger.warn(
      `PAYOUT triggered: policy=${policy.id} holder=${policy.holder} payout=${result.payout} reason="${result.reason}"`
    );

    const expectedPayout = BigInt(result.expectedPayout ?? result.payout);
    const settlement = await this.claimSettlementService.settleClaim(policy.id, policy.holder, expectedPayout);
    if (!settlement.settled) {
      this.logger.error(`Settlement did not confirm for policy ${policy.id}, will retry next scan: ${settlement.error}`);
      return undefined;
    }

    const actualPayout = settlement.actualPayout;
    // Authoritative amount: on-chain actual when known; otherwise keep expected
    // but do NOT coerce missing returnValue to 0 (would understate totals).
    let recordedPayout = expectedPayout;
    let payoutDiscrepancy = false;

    if (actualPayout === null || actualPayout === undefined) {
      this.logger.warn(
        `Settlement confirmed for policy ${policy.id} but return value missing — recording expected payout ${expectedPayout}`
      );
    } else {
      recordedPayout = actualPayout;
      const delta = actualPayout >= expectedPayout ? actualPayout - expectedPayout : expectedPayout - actualPayout;
      if (delta > mismatchTolerance) {
        payoutDiscrepancy = true;
        const record: PayoutDiscrepancyRecord = {
          policyId: policy.id,
          expectedPayout: expectedPayout.toString(),
          actualPayout: actualPayout.toString(),
          txHash: settlement.txHash,
          at: Date.now(),
        };
        this.discrepancies.push(record);
        this.logger.error(
          `PAYOUT DISCREPANCY policy=${policy.id} expected=${expectedPayout} actual=${actualPayout} tx=${settlement.txHash}`
        );
      }
    }

    this.logger.log(`Settlement confirmed for policy ${policy.id}: tx=${settlement.txHash} payout=${recordedPayout}`);
    this.policyService.deactivate(policy.id);
    this.processedCount++;
    this.payoutTotal += recordedPayout;
    const settledResult: ClaimResult = {
      ...result,
      payout: recordedPayout.toString(),
      expectedPayout: expectedPayout.toString(),
      settlementTxHash: settlement.txHash,
      payoutDiscrepancy: payoutDiscrepancy || undefined,
    };
    this.history.push(settledResult);
    return settledResult;
  }

  getStats() {
    return {
      activePolicies: this.policyService.listActive().length,
      processedClaims: this.processedCount,
      // Totals from actual (authoritative) payouts.
      totalPayout: this.payoutTotal.toString(),
      // Surfaces whether ClaimSettlementService actually has a pool
      // contract ID + relayer secret configured, so ops can tell from the
      // API whether triggered claims will settle on-chain or just log a
      // "not configured" error, without digging through env/logs.
      settlementConfigured: this.claimSettlementService.isConfigured(),
      lastScan: this.lastScanStats,
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
