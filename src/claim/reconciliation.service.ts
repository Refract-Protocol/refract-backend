import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PolicyService } from "../policy/policy.service";
import { ClaimService } from "./claim.service";

/**
 * Scheduled reconciliation job that detects and reports four specific
 * classes of data-consistency drift:
 *
 *  1. **Expired-but-active policies** — policies whose expiresAt is in the
 *     past but whose isActive flag is still true.  PolicyService.listActive()
 *     filters these out silently; they still appear in findByHolder() and
 *     GET /api/v1/policies/holder/:address without a clear "expired" label.
 *
 *  2. **Policies with settlements but still active** — a policy that has a
 *     settled claim in ClaimService history but is still marked isActive.
 *     Indicates a crash between on-chain confirmation and deactivation in
 *     ClaimService.processPayout().
 *
 *  3. **Uncapped settlement retry policies** — active policies that appear
 *     in the settled claim history (indicating repeated failed settlement
 *     attempts without deactivation) and have exceeded MAX_SETTLEMENT_RETRIES.
 *     With no cap today these retry forever and invisibly.
 *
 *  4. **Settlement history orphans** — settled claim records whose policy_id
 *     doesn't match any known policy in PolicyService, indicating the policy
 *     was removed from the in-memory store mid-flight.
 *
 * This job reports all findings via structured log entries.  No automatic
 * correction is applied — that requires a Postgres-backed store so fixes
 * are durable.  The log entries are designed to be actionable by an
 * on-call engineer or a future auto-remediation step.
 *
 * Run cadence: every 15 minutes, offset from the 5-minute claim scanner
 * (ClaimScheduler) to avoid lock contention on the in-memory stores.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  /**
   * Number of times a claim can appear in the settlement failure log before
   * the reconciliation job flags it as "stuck".  The ClaimScheduler runs
   * every 300 s — 12 retries ≈ 1 hour of repeated failures.
   */
  private static readonly MAX_SETTLEMENT_RETRIES = 12;

  /**
   * Tracks per-policy failed settlement attempt counts so we can detect
   * policies that are retrying indefinitely.  Keyed by policy id.
   *
   * In a Postgres-backed implementation this counter lives in a
   * `settlement_retries` column on the claims/policies table; here we keep
   * it in memory with the same lifetime as PolicyService's store.
   */
  private readonly failedSettlementCounts = new Map<string, number>();

  constructor(
    private readonly policyService: PolicyService,
    private readonly claimService: ClaimService
  ) {}

  // ─── Public API for ClaimService to report failed settlements ─────────────

  /**
   * Called by ClaimService when a settlement does NOT confirm so this
   * service can increment the retry counter and flag stuck policies
   * without waiting for the next scheduled reconciliation run.
   */
  recordFailedSettlement(policyId: string): void {
    const current = this.failedSettlementCounts.get(policyId) ?? 0;
    const next = current + 1;
    this.failedSettlementCounts.set(policyId, next);

    if (next >= ReconciliationService.MAX_SETTLEMENT_RETRIES) {
      this.logger.error(
        `RECONCILIATION [stuck-settlement]: policy ${policyId} has failed settlement ` +
        `${next} time(s) (cap=${ReconciliationService.MAX_SETTLEMENT_RETRIES}). ` +
        `Manual intervention required — check ORACLE_RELAYER_SECRET, pool contract, and RPC health.`
      );
    }
  }

  // ─── Scheduled reconciliation ─────────────────────────────────────────────

  /** Every 15 minutes — offset from the 5-minute ClaimScheduler. */
  @Cron("2,17,32,47 * * * *")
  async reconcile(): Promise<void> {
    try {
      await this.checkExpiredActivePolicy();
      await this.checkSettledButActivePolicies();
      await this.checkStuckSettlements();
      await this.checkOrphanedSettlementHistory();
    } catch (err) {
      this.logger.error("Reconciliation run failed", err instanceof Error ? err.stack : String(err));
    }
  }

  // ─── Individual checks ────────────────────────────────────────────────────

  /**
   * Check 1: policies past their expiry date but still marked isActive.
   * These are silently excluded from listActive() scans but are returned
   * as seemingly-active by findByHolder(), so a holder sees "active"
   * coverage that is actually past expiry.
   */
  private async checkExpiredActivePolicy(): Promise<void> {
    const expired = this.policyService.getExpiredActive();
    for (const policy of expired) {
      this.logger.warn(
        `RECONCILIATION [expired-active]: policy ${policy.id} ` +
        `holder=${policy.holder} type=${policy.coverageType} ` +
        `expired=${new Date(policy.expiresAt * 1000).toISOString()} ` +
        `but isActive=true — should be deactivated`
      );
    }
    if (expired.length > 0) {
      this.logger.warn(
        `RECONCILIATION summary: ${expired.length} expired-but-active polic${expired.length === 1 ? "y" : "ies"} found`
      );
    }
  }

  /**
   * Check 2: policies with a committed settlement in ClaimService history
   * but still marked isActive — indicates a crash after on-chain
   * confirmation but before PolicyService.deactivate() was called.
   */
  private async checkSettledButActivePolicies(): Promise<void> {
    const recentSettlements = this.claimService.getRecentSettlements(500);
    const settledPolicyIds = new Set(recentSettlements.map((r) => r.policyId));

    const activePolicies = this.policyService.listActive();
    for (const policy of activePolicies) {
      if (settledPolicyIds.has(policy.id)) {
        this.logger.error(
          `RECONCILIATION [settled-but-active]: policy ${policy.id} ` +
          `holder=${policy.holder} has a confirmed settlement in history ` +
          `but isActive=true — payout may have been double-counted`
        );
      }
    }
  }

  /**
   * Check 3: active policies with a stuck settlement retry counter.
   */
  private async checkStuckSettlements(): Promise<void> {
    for (const [policyId, count] of this.failedSettlementCounts) {
      if (count >= ReconciliationService.MAX_SETTLEMENT_RETRIES) {
        const policy = this.policyService.findById(policyId);
        const holder = policy?.holder ?? "unknown";
        this.logger.error(
          `RECONCILIATION [stuck-settlement]: policy ${policyId} ` +
          `holder=${holder} has ${count} consecutive failed settlements ` +
          `(max=${ReconciliationService.MAX_SETTLEMENT_RETRIES}). ` +
          `Settlement will keep retrying every 5 minutes until resolved.`
        );
      }
    }
  }

  /**
   * Check 4: settled claim records whose policy_id isn't in PolicyService —
   * e.g. if the in-memory store was ever wiped without deactivating existing
   * claims (restart with a new in-memory map, while history persisted via
   * another mechanism).
   */
  private async checkOrphanedSettlementHistory(): Promise<void> {
    const recentSettlements = this.claimService.getRecentSettlements(500);
    for (const claim of recentSettlements) {
      const policy = this.policyService.findById(claim.policyId);
      if (!policy) {
        this.logger.warn(
          `RECONCILIATION [orphaned-settlement]: settled claim for policy ${claim.policyId} ` +
          `holder=${claim.holder} has no matching policy in store — ` +
          `policy was likely removed without proper deactivation`
        );
      }
    }
  }
}
