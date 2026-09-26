import { Injectable, Logger } from "@nestjs/common";
import { OracleReading } from "../oracle/oracle-reading";
import { OracleService } from "../oracle/oracle.service";
import { PolicyService, StoredPolicy } from "../policy/policy.service";
import { ClaimSettlementService } from "./claim-settlement.service";
import { ClaimResult } from "./claim-result";

const STALENESS_LIMIT_SECONDS = 1800; // 30 minutes — matches the old ClaimProcessor

/** Per-policy outcome of a scan, including dry-run evaluations. */
export interface ScanPolicyResult {
  policyId: string;
  holder: string;
  coverageType: number;
  triggered: boolean;
  reason: string;
  oracleValue: number;
  oracleThreshold: number;
  oracleMessage: string;
  settled: boolean;
  settlementTxHash?: string;
  error?: string;
}

/** Structured result of a single scan run (manual or scheduled). */
export interface ScanRunResult {
  dryRun: boolean;
  startedAt: number;
  durationMs: number;
  scanned: number;
  triggered: number;
  settled: number;
  failed: number;
  results: ScanPolicyResult[];
}

/** A recorded scan run for the ops scan-history endpoint. */
export interface ScanHistoryEntry {
  dryRun: boolean;
  startedAt: number;
  durationMs: number;
  scanned: number;
  triggered: number;
  settled: number;
  failed: number;
  errors: string[];
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
  // Guards against overlapping scans (scheduled or manual).
  private scanInProgress = false;
  // Recent scan runs for the ops scan-history endpoint.
  private readonly scanHistory: ScanHistoryEntry[] = [];

  constructor(
    private readonly policyService: PolicyService,
    private readonly oracleService: OracleService,
    private readonly claimSettlementService: ClaimSettlementService
  ) {}

  /** True while a scan (scheduled or manual) is running. */
  isScanInProgress(): boolean {
    return this.scanInProgress;
  }

  async processTriggered(): Promise<ClaimResult[]> {
    const run = await this.runScan(false);
    return run.results
      .filter((r) => r.settled)
      .map((r) => ({
        policyId: r.policyId,
        holder: r.holder,
        coverageType: r.coverageType,
        triggered: r.triggered,
        payout: r.triggered ? this.policyService.getById(r.policyId)?.coverageAmount ?? "0" : "0",
        reason: r.reason,
        processedAt: run.startedAt,
        settlementTxHash: r.settlementTxHash,
      }));
  }

  /**
   * Mode-aware scan body shared by the scheduled scan and the ops endpoints.
   * When `dryRun` is true every active policy is evaluated through exactly the
   * same path as a real scan, but no settlement is submitted and no policy is
   * deactivated — making it provably side-effect-free.
   */
  async runScan(dryRun: boolean): Promise<ScanRunResult> {
    if (this.scanInProgress) {
      throw new Error("SCAN_IN_PROGRESS");
    }
    this.scanInProgress = true;
    const startedAt = Date.now();
    const results: ScanPolicyResult[] = [];
    try {
      const activePolicies = this.policyService.listActive();
      if (activePolicies.length > 0) {
        this.logger.log(
          `${dryRun ? "Dry-run scanning" : "Scanning"} ${activePolicies.length} active polic${
            activePolicies.length === 1 ? "y" : "ies"
          }`
        );
      }

      for (const policy of activePolicies) {
        results.push(await this.scanPolicy(policy, dryRun));
      }
    } finally {
      this.scanInProgress = false;
    }

    const run: ScanRunResult = {
      dryRun,
      startedAt,
      durationMs: Date.now() - startedAt,
      scanned: results.length,
      triggered: results.filter((r) => r.triggered).length,
      settled: results.filter((r) => r.settled).length,
      failed: results.filter((r) => r.error).length,
      results,
    };
    this.recordScan(run);
    return run;
  }

  /**
   * Evaluates a single policy and, unless `dryRun`, attempts settlement.
   * Returns a structured per-policy result so operators can see the oracle
   * reading, the trigger decision, and any settlement failure.
   */
  async scanPolicy(policy: StoredPolicy, dryRun: boolean): Promise<ScanPolicyResult> {
    const base: ScanPolicyResult = {
      policyId: policy.id,
      holder: policy.holder,
      coverageType: policy.coverageType,
      triggered: false,
      reason: "",
      oracleValue: 0,
      oracleThreshold: 0,
      oracleMessage: "",
      settled: false,
    };

    try {
      const fetchedAt = Math.floor(Date.now() / 1000);
      const oracle = await this.fetchOracleData(policy);
      const result = this.evaluatePolicy(policy, oracle, fetchedAt);
      const evaluated: ScanPolicyResult = {
        ...base,
        triggered: result.triggered,
        reason: result.reason,
        oracleValue: oracle.value,
        oracleThreshold: oracle.threshold,
        oracleMessage: oracle.message,
      };

      if (!result.triggered || dryRun) return evaluated;

      const settledResult = await this.processPayout(policy, result);
      if (settledResult) {
        return { ...evaluated, settled: true, settlementTxHash: settledResult.settlementTxHash };
      }
      return { ...evaluated, error: "Settlement did not confirm" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error scanning policy ${policy.id}`, err instanceof Error ? err.stack : message);
      return { ...base, error: message };
    }
  }

  private recordScan(run: ScanRunResult): void {
    this.scanHistory.push({
      dryRun: run.dryRun,
      startedAt: run.startedAt,
      durationMs: run.durationMs,
      scanned: run.scanned,
      triggered: run.triggered,
      settled: run.settled,
      failed: run.failed,
      errors: run.results.filter((r) => r.error).map((r) => `${r.policyId}: ${r.error}`),
    });
    if (this.scanHistory.length > 50) this.scanHistory.shift();
  }

  /** Recent scan runs, most recent first. */
  getScanHistory(limit = 20): ScanHistoryEntry[] {
    return [...this.scanHistory].reverse().slice(0, limit);
  }

  /**
   * Current oracle reading and trigger evaluation for one policy, exposing the
   * raw value, threshold, comparison direction, and staleness so operators can
   * diagnose evaluation bugs without reading live-host logs.
   */
  async getEvaluation(policyId: string): Promise<{
    policyId: string;
    coverageType: number;
    oracleValue: number;
    oracleThreshold: number;
    oracleMessage: string;
    comparison: "above" | "below";
    triggered: boolean;
    reason: string;
    stalenessSeconds: number;
    stale: boolean;
  }> {
    const policy = this.policyService.getById(policyId);
    if (!policy) throw new Error("POLICY_NOT_FOUND");

    const fetchedAt = Math.floor(Date.now() / 1000);
    const oracle = await this.fetchOracleData(policy);
    const result = this.evaluatePolicy(policy, oracle, fetchedAt);
    const stalenessSeconds = Math.floor(Date.now() / 1000) - fetchedAt;

    return {
      policyId: policy.id,
      coverageType: policy.coverageType,
      oracleValue: oracle.value,
      oracleThreshold: oracle.threshold,
      oracleMessage: oracle.message,
      comparison: policy.coverageType === 4 ? "above" : "below",
      triggered: result.triggered,
      reason: result.reason,
      stalenessSeconds,
      stale: stalenessSeconds > STALENESS_LIMIT_SECONDS,
    };
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
