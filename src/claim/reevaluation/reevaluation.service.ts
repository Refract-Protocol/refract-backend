import { Logger } from "@nestjs/common";
import type { QuorumVerdict } from "../../oracle/regions/region-quorum";
import type { TrustTransition } from "../../oracle/regions/regional-quorum.aggregator";
import { TriggerStabilityConfig, defaultTriggerConfig } from "../trigger/trigger-stability";
import { AdjudicationRecord } from "./adjudication";
import { ReevaluationAction, ReevaluationItem, ReevaluationPlan, TrustedReading, planReevaluation } from "./reevaluation-planner";

/**
 * In-memory store of claim decisions made while a feed wasn't trusted.
 * Consecutive identical decisions for a policy collapse into one record (the
 * first), so a policy held across 500 scans is one record, not 500.
 */
export class AdjudicationLedger {
  private readonly records = new Map<string, AdjudicationRecord>();
  private readonly latestByPolicy = new Map<string, string>();
  private readonly paidPolicies = new Set<string>();

  record(rec: AdjudicationRecord): boolean {
    if (rec.outcome === "settled") this.paidPolicies.add(rec.policyId);
    const prevId = this.latestByPolicy.get(rec.policyId);
    const prev = prevId ? this.records.get(prevId) : undefined;
    if (
      prev &&
      !prev.reevaluatedBy &&
      prev.outcome === rec.outcome &&
      prev.feedId === rec.feedId &&
      prev.trustState === rec.trustState &&
      rec.outcome !== "settled"
    ) {
      return false;
    }
    if (this.records.has(rec.id)) return false;
    this.records.set(rec.id, { ...rec });
    this.latestByPolicy.set(rec.policyId, rec.id);
    return true;
  }

  /** Records for a feed not yet taken by a re-evaluation run. */
  pending(feedId: string): AdjudicationRecord[] {
    return [...this.records.values()].filter((r) => r.feedId === feedId && !r.reevaluatedBy).map((r) => ({ ...r }));
  }

  markReevaluated(recordIds: readonly string[], runId: string): void {
    for (const id of recordIds) {
      const r = this.records.get(id);
      if (r && !r.reevaluatedBy) r.reevaluatedBy = runId;
    }
  }

  markPaid(policyId: string): void {
    this.paidPolicies.add(policyId);
  }

  isPaid(policyId: string): boolean {
    return this.paidPolicies.has(policyId);
  }

  paid(): ReadonlySet<string> {
    return new Set(this.paidPolicies);
  }
}

/** Rolling store of quorum-trusted values per feed, used as evidence for re-adjudication. */
export class TrustedReadingHistory {
  private readonly byFeed = new Map<string, TrustedReading[]>();

  constructor(private readonly retentionMs = 14 * 24 * 60 * 60_000) {}

  recordVerdict(v: QuorumVerdict): void {
    if (v.trust !== "trusted" || v.value === null) return;
    this.add(v.feedId, { observedAt: v.evaluatedAt, value: v.value, provenance: "quorum" });
  }

  add(feedId: string, reading: TrustedReading): void {
    const list = this.byFeed.get(feedId) ?? [];
    if (list.some((r) => r.observedAt === reading.observedAt && r.provenance === reading.provenance)) return;
    list.push(reading);
    const cutoff = reading.observedAt - this.retentionMs;
    this.byFeed.set(
      feedId,
      list.filter((r) => r.observedAt >= cutoff).sort((a, b) => a.observedAt - b.observedAt),
    );
  }

  between(feedId: string, from: number, to: number): TrustedReading[] {
    return (this.byFeed.get(feedId) ?? []).filter((r) => r.observedAt >= from && r.observedAt <= to);
  }
}

export type ItemStatus = "pending" | "done" | "failed" | "flagged" | "reversal_approved";

/** Append-only audit entry on a run. Entries are never edited or removed. */
export interface RunAuditEntry {
  at: number;
  actor: string;
  event: "planned" | "apply_started" | "item_settled" | "item_failed" | "item_skipped" | "reversal_approved";
  recordId?: string;
  detail?: string;
}

export interface ReevaluationRun extends ReevaluationPlan {
  status: "planned" | "applying" | "applied" | "partially_applied";
  createdAt: number;
  appliedAt?: number;
  appliedBy?: string;
  itemStatus: Record<string, { status: ItemStatus; txHash?: string; error?: string }>;
  audit: ReadonlyArray<Readonly<RunAuditEntry>>;
}

export class FeedStillUntrustedError extends Error {}

/** Most actionable items one apply() call processes; call again to continue. */
export const DEFAULT_APPLY_BATCH = 50;

export interface ReevaluationSettlementExecutor {
  settle(item: ReevaluationItem, run: ReevaluationRun): Promise<{ settled: boolean; txHash?: string; error?: string }>;
}

export interface ReevaluationConfig {
  lookbackMs: number;
  confirmWindowMs: number;
  triggerConfigFor: (coverageType: number) => TriggerStabilityConfig;
}

export const DEFAULT_REEVALUATION_CONFIG: ReevaluationConfig = {
  lookbackMs: 15 * 60_000,
  confirmWindowMs: 30 * 60_000,
  triggerConfigFor: (coverageType) => defaultTriggerConfig(coverageType),
};

/**
 * Re-adjudicates claims once a feed's trust is restored.
 *
 * - Tracks when each feed left the trusted state.
 * - On the transition back to trusted, plans a run over that feed's pending
 *   records. Planning is automatic; paying out is not: an operator reviews
 *   the diff and calls apply().
 * - apply() is idempotent: done items are skipped, failed items are
 *   retried, and a policy already paid is never paid twice.
 */
export class ReevaluationService {
  private readonly logger = new Logger(ReevaluationService.name);
  private readonly degradedSince = new Map<string, number>();
  private readonly runs = new Map<string, ReevaluationRun>();

  constructor(
    readonly ledger: AdjudicationLedger = new AdjudicationLedger(),
    readonly history: TrustedReadingHistory = new TrustedReadingHistory(),
    private readonly config: ReevaluationConfig = DEFAULT_REEVALUATION_CONFIG,
  ) {}

  /** Wire to RegionalQuorumAggregator.onVerdict. */
  onVerdict(v: QuorumVerdict): void {
    this.history.recordVerdict(v);
  }

  /** Wire to RegionalQuorumAggregator.onTrustTransition. */
  onTrustTransition(t: TrustTransition): ReevaluationRun | undefined {
    if (t.to !== "trusted") {
      if (!this.degradedSince.has(t.feedId)) this.degradedSince.set(t.feedId, t.at);
      return undefined;
    }
    const since = this.degradedSince.get(t.feedId);
    this.degradedSince.delete(t.feedId);
    if (since === undefined && this.ledger.pending(t.feedId).length === 0) return undefined;
    return this.buildRun(t.feedId, t.at, t.at, [], since);
  }

  /**
   * Plans (or returns the existing) run for a feed's pending records. Operator
   * backfill readings are kept apart from quorum readings in the evidence.
   * Refuses while the feed is still untrusted: re-adjudicating against
   * evidence that is itself unverified would just repeat the problem.
   */
  plan(feedId: string, restoredAt: number, now: number, backfill: readonly Omit<TrustedReading, "provenance">[] = []): ReevaluationRun | undefined {
    if (this.degradedSince.has(feedId)) {
      throw new FeedStillUntrustedError(`Feed ${feedId} is still untrusted; re-evaluation waits for trust to be restored`);
    }
    return this.buildRun(feedId, restoredAt, now, backfill, undefined);
  }

  private buildRun(
    feedId: string,
    restoredAt: number,
    now: number,
    backfill: readonly Omit<TrustedReading, "provenance">[],
    trackedSince: number | undefined,
  ): ReevaluationRun | undefined {
    const records = this.ledger.pending(feedId);
    if (records.length === 0) return undefined;
    const earliest = Math.min(...records.map((r) => r.decidedAt));
    const degradedSince = Math.min(trackedSince ?? earliest, earliest);
    const from = degradedSince - this.config.lookbackMs;
    const to = restoredAt + this.config.confirmWindowMs;
    const trustedReadings: TrustedReading[] = [
      ...this.history.between(feedId, from, to),
      ...backfill.map((b) => ({ observedAt: b.observedAt, value: b.value, provenance: "operator_backfill" as const })),
    ];

    const plan = planReevaluation({
      feedId,
      degradedSince,
      restoredAt,
      records,
      trustedReadings,
      triggerConfigFor: this.config.triggerConfigFor,
      alreadyPaidPolicies: this.ledger.paid(),
      lookbackMs: this.config.lookbackMs,
      confirmWindowMs: this.config.confirmWindowMs,
    });

    const existing = this.runs.get(plan.runId);
    if (existing) return existing;

    const run: ReevaluationRun = {
      ...plan,
      status: "planned",
      createdAt: now,
      itemStatus: Object.fromEntries(plan.items.map((i) => [i.recordId, { status: "pending" as ItemStatus }])),
      audit: [Object.freeze<RunAuditEntry>({ at: now, actor: "system", event: "planned", detail: `${plan.summary.affected} affected, ${plan.summary.changed} changed` })],
    };
    this.runs.set(run.runId, run);
    this.ledger.markReevaluated(records.map((r) => r.id), run.runId);
    this.logger.warn(
      `Planned re-evaluation ${run.runId} for ${feedId}: ${run.summary.affected} affected, ${run.summary.changed} changed, ` +
        `${run.summary.settle} to settle, ${run.summary.flag_overpayment} flagged, ${run.summary.manual_review} need review`,
    );
    return run;
  }

  listRuns(): ReevaluationRun[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt || a.runId.localeCompare(b.runId));
  }

  getRun(runId: string): ReevaluationRun | undefined {
    return this.runs.get(runId);
  }

  /**
   * Executes a run's actions in item order, at most `maxItems` unfinished
   * items per call. Safe to call again to continue or to retry failures.
   */
  async apply(
    runId: string,
    executor: ReevaluationSettlementExecutor,
    actor: string,
    now: number,
    maxItems = DEFAULT_APPLY_BATCH,
  ): Promise<ReevaluationRun> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown re-evaluation run ${runId}`);
    if (run.status === "applying") throw new Error(`Re-evaluation run ${runId} is already being applied`);
    if (!Number.isInteger(maxItems) || maxItems < 1) throw new Error("maxItems must be a positive integer");
    run.status = "applying";
    this.audit(run, { at: now, actor, event: "apply_started", detail: `batch ${maxItems}` });

    try {
      let processed = 0;
      for (const item of run.items) {
        const state = run.itemStatus[item.recordId];
        if (state.status !== "pending" && state.status !== "failed") continue;
        if (processed >= maxItems) break;
        processed++;
        state.status = await this.applyItem(item, run, executor, state);
        if (item.action === "settle") {
          const event = state.status === "failed" ? "item_failed" : state.error ? "item_skipped" : "item_settled";
          this.audit(run, { at: now, actor, event, recordId: item.recordId, detail: state.txHash ?? state.error });
        }
      }
    } finally {
      const statuses = Object.values(run.itemStatus).map((s) => s.status);
      run.status = statuses.some((s) => s === "failed" || s === "pending") ? "partially_applied" : "applied";
      run.appliedAt = now;
      run.appliedBy = actor;
    }
    return run;
  }

  /**
   * Records an operator's approval to reverse a flagged overpayment. This
   * only records the decision (append-only); the reversal itself is an
   * off-system action, since there is no on-chain clawback.
   */
  approveReversal(runId: string, recordId: string, actor: string, note: string, now: number): ReevaluationRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown re-evaluation run ${runId}`);
    const item = run.items.find((i) => i.recordId === recordId);
    if (!item || item.action !== "flag_overpayment") throw new Error(`Record ${recordId} is not a flagged overpayment in ${runId}`);
    const state = run.itemStatus[recordId];
    if (state.status === "reversal_approved") return run;
    state.status = "reversal_approved";
    this.audit(run, { at: now, actor, event: "reversal_approved", recordId, detail: note });
    return run;
  }

  private audit(run: ReevaluationRun, entry: RunAuditEntry): void {
    (run.audit as RunAuditEntry[]).push(Object.freeze({ ...entry }));
  }

  private async applyItem(
    item: ReevaluationItem,
    run: ReevaluationRun,
    executor: ReevaluationSettlementExecutor,
    state: { status: ItemStatus; txHash?: string; error?: string },
  ): Promise<ItemStatus> {
    const flaggedActions: ReadonlySet<ReevaluationAction> = new Set(["flag_overpayment", "manual_review"]);
    if (flaggedActions.has(item.action)) return "flagged";
    if (item.action !== "settle") return "done";
    if (this.ledger.isPaid(item.policyId)) {
      state.error = "policy already paid; skipped to avoid a double payout";
      return "done";
    }
    try {
      const res = await executor.settle(item, run);
      if (!res.settled) {
        state.error = res.error ?? "settlement did not confirm";
        return "failed";
      }
      this.ledger.markPaid(item.policyId);
      state.txHash = res.txHash;
      state.error = undefined;
      return "done";
    } catch (err) {
      state.error = (err as Error).message;
      return "failed";
    }
  }
}
