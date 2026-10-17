/**
 * On-Chain Trust-Engine Pause State Propagator and Kill-Switch Control Plane (Issue #276)
 *
 * Maintains authoritative pause state per feed and coverage type, blocks reading
 * publication and claim settlement while paused, queues high-priority idempotent
 * `set_feed_status` transactions in a durable outbox that survives relayer outages,
 * and requires explicit acknowledgment before resuming circuit-breaker auto-pauses.
 */

export type PauseTargetKind = "feed" | "coverage";

export type PauseTriggerSource = "operator_manual" | "circuit_breaker_auto";

export interface PauseControlRecord {
  targetKind: PauseTargetKind;
  targetId: string;
  paused: boolean;
  source: PauseTriggerSource;
  actorId: string;
  reason: string;
  updatedAtMs: number;
  lastConfirmedTxHash?: string;
}

export interface SetFeedStatusContractPayload {
  contractMethod: "set_feed_status";
  targetKind: PauseTargetKind;
  targetId: string;
  paused: boolean;
  reasonHashHex: string;
  timestampSec: number;
  idempotencyKey: string;
}

export interface PausePropagationOutboxItem {
  outboxId: string;
  idempotencyKey: string;
  priority: "critical_kill_switch";
  payload: SetFeedStatusStatusPayloadAlias;
  attempts: number;
  status: "pending_submission" | "confirmed" | "skipped_feature_flag";
  lastError?: string;
  txHash?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

type SetFeedStatusStatusPayloadAlias = SetFeedStatusContractPayload;

export interface PauseControlStore {
  loadAll(): {
    records: PauseControlRecord[];
    outbox: PausePropagationOutboxItem[];
  };
  saveAll(state: {
    records: PauseControlRecord[];
    outbox: PausePropagationOutboxItem[];
  }): void;
}

export class InMemoryPauseControlStore implements PauseControlStore {
  private records: PauseControlRecord[] = [];
  private outbox: PausePropagationOutboxItem[] = [];

  loadAll() {
    return {
      records: this.records.map((r) => ({ ...r })),
      outbox: this.outbox.map((o) => ({ ...o, payload: { ...o.payload } })),
    };
  }

  saveAll(state: {
    records: PauseControlRecord[];
    outbox: PausePropagationOutboxItem[];
  }): void {
    this.records = state.records.map((r) => ({ ...r }));
    this.outbox = state.outbox.map((o) => ({ ...o, payload: { ...o.payload } }));
  }
}

export type OnChainStatusSubmitter = (
  payload: SetFeedStatusContractPayload
) => Promise<{ txHash: string }>;

function simpleReasonHashHex(reason: string): string {
  let h = 2166136261;
  for (let i = 0; i < reason.length; i++) {
    h ^= reason.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export class TrustEnginePauseController {
  private readonly store: PauseControlStore;
  private readonly enableOnChainPropagation: boolean;
  private seq = 0;

  constructor(options: {
    store?: PauseControlStore;
    enableOnChainPropagation?: boolean;
  } = {}) {
    this.store = options.store ?? new InMemoryPauseControlStore();
    this.enableOnChainPropagation = options.enableOnChainPropagation ?? true;
  }

  /**
   * Pauses a feed or coverage type, immediately halting backend publication/settlement
   * and enqueueing a high-priority `set_feed_status` transaction in the durable outbox.
   */
  pauseTarget(params: {
    targetKind: PauseTargetKind;
    targetId: string;
    source: PauseTriggerSource;
    actorId: string;
    reason: string;
    nowMs: number;
  }): { record: PauseControlRecord; outboxItem: PausePropagationOutboxItem } {
    this.validateActorAndReason(params.actorId, params.reason);
    const state = this.store.loadAll();
    const key = `${params.targetKind}:${params.targetId}`;

    const record: PauseControlRecord = {
      targetKind: params.targetKind,
      targetId: params.targetId,
      paused: true,
      source: params.source,
      actorId: params.actorId.trim(),
      reason: params.reason.trim(),
      updatedAtMs: params.nowMs,
    };

    const existingIdx = state.records.findIndex(
      (r) => `${r.targetKind}:${r.targetId}` === key
    );
    if (existingIdx >= 0) {
      state.records[existingIdx] = record;
    } else {
      state.records.push(record);
    }

    const outboxItem = this.enqueueOutboxTransition(state.outbox, record);
    this.store.saveAll(state);
    return { record, outboxItem };
  }

  /**
   * Resumes a paused feed or coverage type.
   * Requires explicit acknowledgment if the target was auto-paused by the circuit breaker.
   */
  resumeTarget(params: {
    targetKind: PauseTargetKind;
    targetId: string;
    actorId: string;
    reason: string;
    acknowledgeCircuitBreakerAutoPause?: boolean;
    nowMs: number;
  }): { record: PauseControlRecord; outboxItem: PausePropagationOutboxItem } {
    this.validateActorAndReason(params.actorId, params.reason);
    const state = this.store.loadAll();
    const existingIdx = state.records.findIndex(
      (r) =>
        r.targetKind === params.targetKind && r.targetId === params.targetId
    );
    if (existingIdx < 0 || !state.records[existingIdx].paused) {
      throw new Error(
        `Target ${params.targetKind}:${params.targetId} is not currently paused`
      );
    }

    const current = state.records[existingIdx];
    if (
      current.source === "circuit_breaker_auto" &&
      !params.acknowledgeCircuitBreakerAutoPause
    ) {
      throw new Error(
        `Cannot resume ${params.targetKind}:${params.targetId} without explicit acknowledgeCircuitBreakerAutoPause=true (paused by circuit_breaker_auto)`
      );
    }

    const updated: PauseControlRecord = {
      ...current,
      paused: false,
      source: "operator_manual",
      actorId: params.actorId.trim(),
      reason: params.reason.trim(),
      updatedAtMs: params.nowMs,
    };
    state.records[existingIdx] = updated;

    const outboxItem = this.enqueueOutboxTransition(state.outbox, updated);
    this.store.saveAll(state);
    return { record: updated, outboxItem };
  }

  /**
   * Flushes pending high-priority pause/resume outbox items to the Soroban oracle contract.
   * Survives RPC/relayer errors so failed items remain `pending_submission` for retry.
   */
  async flushOnChainOutbox(
    submitter: OnChainStatusSubmitter,
    nowMs: number
  ): Promise<PausePropagationOutboxItem[]> {
    const state = this.store.loadAll();
    const processed: PausePropagationOutboxItem[] = [];

    for (const item of state.outbox) {
      if (item.status !== "pending_submission") {
        continue;
      }

      if (!this.enableOnChainPropagation) {
        item.status = "skipped_feature_flag";
        item.updatedAtMs = nowMs;
        processed.push({ ...item });
        continue;
      }

      item.attempts += 1;
      item.updatedAtMs = nowMs;

      try {
        const { txHash } = await submitter(item.payload);
        item.status = "confirmed";
        item.txHash = txHash;
        item.lastError = undefined;

        const rec = state.records.find(
          (r) =>
            r.targetKind === item.payload.targetKind &&
            r.targetId === item.payload.targetId
        );
        if (rec) {
          rec.lastConfirmedTxHash = txHash;
        }
      } catch (err) {
        item.lastError = err instanceof Error ? err.message : String(err);
      }

      processed.push({ ...item });
    }

    this.store.saveAll(state);
    return processed;
  }

  /**
   * Gate used by `oracleMonitor` before publishing a reading.
   */
  canPublishReading(feedId: string): { allowed: boolean; blockReason?: string } {
    const state = this.store.loadAll();
    const feedPause = state.records.find(
      (r) => r.targetKind === "feed" && r.targetId === feedId && r.paused
    );
    if (feedPause) {
      return {
        allowed: false,
        blockReason: `Feed "${feedId}" is paused by ${feedPause.actorId} (${feedPause.source}): ${feedPause.reason}`,
      };
    }
    return { allowed: true };
  }

  /**
   * Gate used by `claimProcessor` before settling a claim.
   */
  canSettleCoverage(
    coverageType: string,
    feedId: string
  ): { allowed: boolean; blockReason?: string } {
    const feedCheck = this.canPublishReading(feedId);
    if (!feedCheck.allowed) {
      return feedCheck;
    }
    const state = this.store.loadAll();
    const covPause = state.records.find(
      (r) =>
        r.targetKind === "coverage" && r.targetId === coverageType && r.paused
    );
    if (covPause) {
      return {
        allowed: false,
        blockReason: `Coverage "${coverageType}" is paused by ${covPause.actorId} (${covPause.source}): ${covPause.reason}`,
      };
    }
    return { allowed: true };
  }

  getTrustPauseStatus(): {
    records: PauseControlRecord[];
    pendingOutboxCount: number;
  } {
    const state = this.store.loadAll();
    const pendingOutboxCount = state.outbox.filter(
      (o) => o.status === "pending_submission"
    ).length;
    return {
      records: state.records,
      pendingOutboxCount,
    };
  }

  private enqueueOutboxTransition(
    outbox: PausePropagationOutboxItem[],
    record: PauseControlRecord
  ): PausePropagationOutboxItem {
    const idempotencyKey = `set_feed_status:${record.targetKind}:${record.targetId}:${record.paused ? "pause" : "resume"}:${record.updatedAtMs}`;
    const existing = outbox.find((o) => o.idempotencyKey === idempotencyKey);
    if (existing) {
      return existing;
    }

    this.seq += 1;
    const payload: SetFeedStatusContractPayload = {
      contractMethod: "set_feed_status",
      targetKind: record.targetKind,
      targetId: record.targetId,
      paused: record.paused,
      reasonHashHex: simpleReasonHashHex(record.reason),
      timestampSec: Math.floor(record.updatedAtMs / 1000),
      idempotencyKey,
    };

    const item: PausePropagationOutboxItem = {
      outboxId: `pause_outbox_${record.updatedAtMs}_${this.seq}`,
      idempotencyKey,
      priority: "critical_kill_switch",
      payload,
      attempts: 0,
      status: "pending_submission",
      createdAtMs: record.updatedAtMs,
      updatedAtMs: record.updatedAtMs,
    };
    outbox.push(item);
    return item;
  }

  private validateActorAndReason(actorId: string, reason: string): void {
    if (!actorId || actorId.trim() === "") {
      throw new Error("Pause/resume actorId must be non-empty");
    }
    if (!reason || reason.trim() === "") {
      throw new Error("Pause/resume reason must be non-empty");
    }
  }
}
