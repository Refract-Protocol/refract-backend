import { Injectable, Logger } from "@nestjs/common";
import { ConsensusDecision } from "../oracle/consensus/consensus-decision";
import { ConsensusService } from "../oracle/consensus/consensus.service";
import { TRIGGER_SPECS } from "../oracle/consensus/trigger-specs";
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
        const result = await this.processPayout(policy, outcome.authorization);
        if (result) settled.push(result);
      } catch (err) {
        this.logger.error(`Error scanning policy ${policy.id}`, err instanceof Error ? err.stack : String(err));
      }
    }

    return settled;
  }

  /** Returns the settled ClaimResult, or undefined if settlement didn't confirm. */
  private async processPayout(policy: StoredPolicy, auth: SettlementAuthorization): Promise<ClaimResult | undefined> {
    const reason = describeDecision(auth.decision);
    this.logger.warn(`PAYOUT authorized: policy=${policy.id} holder=${auth.holder} payout=${auth.payout} ${reason}`);

    const settlement = await this.claimSettlementService.settleClaim(auth.policyId, auth.holder, auth.payout);
    if (!settlement.settled) {
      this.logger.error(`Settlement did not confirm for policy ${policy.id}, will retry next scan: ${settlement.error}`);
      return undefined;
    }

    this.logger.log(`Settlement confirmed for policy ${policy.id}: tx=${settlement.txHash}`);
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
