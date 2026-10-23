import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConsensusDecision } from "../oracle/consensus/consensus-decision";
import { ConsensusService } from "../oracle/consensus/consensus.service";
import { TRIGGER_SPECS } from "../oracle/consensus/trigger-specs";
import { ClaimHoldService, COVERAGE_FEEDS } from "../oracle/consensus/claim-hold.service";
import { OracleControlService } from "../oracle/control";
import { AnomalyDetector } from "../oracle/anomaly";
import { CircuitBreaker } from "../oracle/circuitBreaker";
import { OracleEventRepository } from "../oracle/oracle-event.repository";
import { OracleReading } from "../oracle/oracle-reading";
import { OracleService } from "../oracle/oracle.service";
import { PolicyService, StoredPolicy } from "../policy/policy.service";
import { ClaimSettlementService } from "./claim-settlement.service";
import { ClaimResult } from "./claim-result";
import { authorizeSettlement, SettlementAuthorization } from "./settlement-authorization";

/**
 * ClaimService scans active policies and settles payouts.
 *
 * Its only oracle input is a {@link ConsensusDecision} from
 * ConsensusService. It never reads OracleService readings or anything the
 * monitor last wrote. A payout needs a SettlementAuthorization, which only
 * exists for a decision that is actionable (quorum met, sources agree,
 * confidence high enough, recorded in the evidence trail) and triggered.
 * Anything else (insufficient, conflicted, unrecorded, or a coverage type
 * with no live source) leaves the policy active and unpaid.
 */
@Injectable()
export class ClaimService {
  private readonly logger = new Logger(ClaimService.name);
  private processedCount = 0;
  private payoutTotal = BigInt(0);
  // In-memory settlement history; replaced once the Postgres-backed repository lands.
  private readonly history: ClaimResult[] = [];

  constructor(
    private readonly policyService: PolicyService,
    private readonly consensus: ConsensusService,
    private readonly claimSettlementService: ClaimSettlementService,
    private readonly oracleEventRepository: OracleEventRepository,
    private readonly oracleControl: OracleControlService,
    private readonly anomalyDetector: AnomalyDetector,
    private readonly circuitBreaker: CircuitBreaker,
    // Optional so existing wiring/tests without the consensus layer keep
    // today's behaviour: no gate, settle directly.
    @Optional() private readonly claimHoldService?: ClaimHoldService
  ) {}

  /** Scheduler entry point. */
  async settleClaims(): Promise<ClaimResult[]> {
    return this.processTriggered();
  }

  async processTriggered(): Promise<ClaimResult[]> {
    const activePolicies = this.policyService.listActive();
    const settled: ClaimResult[] = [];
    if (activePolicies.length === 0) return settled;

    this.logger.log(`Scanning ${activePolicies.length} active polic${activePolicies.length === 1 ? "y" : "ies"}`);

    for (const policy of activePolicies) {
      try {
        const spec = TRIGGER_SPECS[policy.coverageType];
        if (!spec) throw new Error(`Unknown coverageType ${policy.coverageType}`);

        const fetchedAt = Math.floor(Date.now() / 1000);
        const oracle = await this.fetchOracleData(policy);
        const anomaly = this.anomalyDetector.evaluate(oracle);
        if (anomaly.triggered) {
          await this.tripBreaker(oracle, anomaly.reasons);
          continue;
        }

        const decision = await this.consensus.decide(policy.coverageType, subjectFor(policy));
        const outcome = authorizeSettlement(policy, spec.coverageType, decision);
        if (!outcome.ok) {
          if (decision.triggered) {
            // Value looks past the threshold but the decision is not
            // trustworthy enough to pay on. Worth an operator's attention.
            this.logger.warn(`Policy ${policy.id} not settled: ${outcome.reason}`);
          }
          continue;
        }

        const result = this.evaluatePolicy(policy, oracle, fetchedAt);
        if (result.triggered) {
          // Operator pause: the reading was already polled and logged above, but
          // no payout is attempted. Checked per policy so a pause issued mid-scan
          // stops the remaining payouts in this run.
          if (await this.oracleControl.isPaused(policy.coverageType)) {
            this.logger.warn(`Settlement skipped for policy ${policy.id}: oracle paused by operator`);
            continue;
          }
          // Only counted/deactivated once the on-chain payout actually
          // confirms — a failed or unconfirmed settlement leaves the
          // policy active so the next scheduled scan retries it.
          const settledResult = await this.processPayout(policy, result, oracle.coverageType);
          if (settledResult) settled.push(settledResult);
        }
        }
        const result = await this.processPayout(policy, outcome.authorization);
        if (result) settled.push(result);
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

  /**
   * Opens the coverage type's breaker and records the trigger as evidence.
   * Throws if persistence fails, so the policy is skipped rather than paid.
   */
  private async tripBreaker(reading: OracleReading, reasons: string[]): Promise<void> {
    const reason = reasons.join("; ");
    const opened = await this.circuitBreaker.open(reading.coverageType, reason, [reading]);
    if (!opened) return;

    this.logger.error(`Circuit breaker OPENED for ${reading.coverageType}: ${reason}`);
    await this.oracleEventRepository.record({
      ...reading,
      severity: "triggered",
      message: `Circuit breaker opened: ${reason} [AnomalyDetector]`,
    });
  }

  /** Returns the settled ClaimResult, or undefined if settlement didn't confirm. */
  private async processPayout(
    policy: StoredPolicy,
    result: ClaimResult,
    coverageType: string
  ): Promise<ClaimResult | undefined> {
    // Re-checked here, not only in the scan loop, so a breaker opened after
    // the value was computed still blocks settlement.
    if (!(await this.circuitBreaker.isSettlementAllowed(coverageType))) {
      this.logger.error(`Settlement blocked for policy ${policy.id}: circuit breaker not closed for ${coverageType}`);
      return undefined;
    }

    this.logger.warn(
      `PAYOUT triggered: policy=${policy.id} holder=${policy.holder} payout=${result.payout} reason="${result.reason}"`
    );

    // Evidence-completeness gate (issue #272). A triggered claim whose
    // evidence is incomplete is put on `payout_held` instead of being paid
    // or dropped. The policy stays active, so the next scan re-checks it and
    // a released hold settles here.
    let holdId: string | undefined;
    if (this.claimHoldService) {
      const gate = this.claimHoldService.gate({
        policyId: policy.id,
        holder: policy.holder,
        feedId: COVERAGE_FEEDS[policy.coverageType] ?? `coverage-${policy.coverageType}`,
        policyExpiresAt: policy.expiresAt * 1000,
      });
      if (gate.action === "block") {
        this.logger.warn(`Payout for policy ${policy.id} not settled: ${gate.reason}`);
        return undefined;
      }
      holdId = gate.holdId;
    }

    const settlement = await this.claimSettlementService.settleClaim(policy.id, policy.holder, BigInt(result.payout));
    if (!settlement.settled) {
      this.logger.error(`Settlement did not confirm for policy ${policy.id}, will retry next scan: ${settlement.error}`);
      return undefined;
    }

    this.logger.log(`Settlement confirmed for policy ${policy.id}: tx=${settlement.txHash}`);
    if (holdId) this.claimHoldService?.markSettled(holdId);
    this.policyService.deactivate(policy.id);
    this.processedCount++;
    this.payoutTotal += auth.payout;
    const result: ClaimResult = {
      policyId: policy.id,
      holder: policy.holder,
      coverageType: policy.coverageType,
      triggered: true,
      payout: auth.payout.toString(),
      reason,
      processedAt: Date.now(),
      triggerDetectedAt: auth.decision.decidedAt,
      settlementTxHash: settlement.txHash,
      decisionId: auth.decision.id,
    };
    this.history.push(result);
    return result;
  }

  getStats() {
    return {
      activePolicies: this.policyService.listActive().length,
      processedClaims: this.processedCount,
      totalPayout: this.payoutTotal.toString(),
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

function subjectFor(policy: StoredPolicy): string | undefined {
  const params = policy.triggerParams ?? {};
  const subject = params.protocolSlug ?? params.flightNumber;
  return typeof subject === "string" ? subject : undefined;
}

function describeDecision(d: ConsensusDecision): string {
  const sources = d.inputs.map((i) => i.sourceId).join(",");
  return `decision=${d.id} status=${d.status} value=${d.value} threshold=${d.threshold} confidence=${d.confidence} sources=[${sources}]`;
}
