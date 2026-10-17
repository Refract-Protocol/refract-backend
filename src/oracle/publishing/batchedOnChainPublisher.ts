export type DecisionPublishPriority = "high_payout_trigger" | "normal_telemetry";

export interface PendingOnChainDecision {
  decisionId: string;
  feedId: string;
  sequenceNumber: number;
  priority: DecisionPublishPriority;
  estimatedBytes: number;
  payload: Record<string, unknown>;
}

export interface SorobanBatchSubmitResult {
  txHash: string;
  ledgerSequence: number;
  latencyMs: number;
}

export interface BackpressureStatus {
  backpressureActive: boolean;
  pendingDepth: number;
  lastRpcLatencyMs: number;
  recommendedLowPriorityPollScale: number; // 1.0 = normal, > 1.0 = slowed polling
}

export class BatchedOnChainOraclePublisher {
  private readonly maxBatchSize: number;
  private readonly maxBatchBytes: number;
  private readonly backpressureQueueThreshold: number;
  private readonly backpressureLatencyThresholdMs: number;
  private readonly submitBatchRpc: (
    batch: PendingOnChainDecision[]
  ) => Promise<SorobanBatchSubmitResult>;

  private readonly pendingById = new Map<string, PendingOnChainDecision>();
  private readonly publishedTxByDecisionId = new Map<string, string>();
  private lastRpcLatencyMs = 0;

  constructor(options: {
    maxBatchSize?: number;
    maxBatchBytes?: number;
    backpressureQueueThreshold?: number;
    backpressureLatencyThresholdMs?: number;
    submitBatchRpc: (
      batch: PendingOnChainDecision[]
    ) => Promise<SorobanBatchSubmitResult>;
  }) {
    this.maxBatchSize = options.maxBatchSize ?? 10;
    this.maxBatchBytes = options.maxBatchBytes ?? 65_536;
    this.backpressureQueueThreshold = options.backpressureQueueThreshold ?? 20;
    this.backpressureLatencyThresholdMs =
      options.backpressureLatencyThresholdMs ?? 2_500;
    this.submitBatchRpc = options.submitBatchRpc;
  }

  public enqueueDecision(decision: PendingOnChainDecision): boolean {
    if (
      this.publishedTxByDecisionId.has(decision.decisionId) ||
      this.pendingById.has(decision.decisionId)
    ) {
      return false;
    }
    this.pendingById.set(decision.decisionId, decision);
    return true;
  }

  public getBackpressureStatus(): BackpressureStatus {
    const pendingDepth = this.pendingById.size;
    const queueBreached = pendingDepth >= this.backpressureQueueThreshold;
    const latencyBreached =
      this.lastRpcLatencyMs >= this.backpressureLatencyThresholdMs;
    const backpressureActive = queueBreached || latencyBreached;

    return {
      backpressureActive,
      pendingDepth,
      lastRpcLatencyMs: this.lastRpcLatencyMs,
      recommendedLowPriorityPollScale: backpressureActive ? 3.0 : 1.0,
    };
  }

  /**
   * Selects the next ordered batch and submits it to Soroban RPC,
   * automatically splitting the batch in half if TX_SIZE_OR_FEE_EXCEEDED occurs.
   */
  public async flushNextBatch(): Promise<{
    publishedDecisionIds: string[];
    txHashes: string[];
  }> {
    const batch = this.buildNextOrderedBatch();
    if (batch.length === 0) {
      return { publishedDecisionIds: [], txHashes: [] };
    }

    const publishedDecisionIds: string[] = [];
    const txHashes: string[] = [];
    await this.submitWithSplitFallback(batch, publishedDecisionIds, txHashes);
    return { publishedDecisionIds, txHashes };
  }

  private async submitWithSplitFallback(
    subBatch: PendingOnChainDecision[],
    publishedDecisionIds: string[],
    txHashes: string[]
  ): Promise<void> {
    if (subBatch.length === 0) return;

    try {
      const res = await this.submitBatchRpc(subBatch);
      this.lastRpcLatencyMs = res.latencyMs;
      txHashes.push(res.txHash);
      for (const item of subBatch) {
        this.pendingById.delete(item.decisionId);
        this.publishedTxByDecisionId.set(item.decisionId, res.txHash);
        publishedDecisionIds.push(item.decisionId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("TX_SIZE_OR_FEE_EXCEEDED") && subBatch.length > 1) {
        const mid = Math.floor(subBatch.length / 2);
        const left = subBatch.slice(0, mid);
        const right = subBatch.slice(mid);
        await this.submitWithSplitFallback(left, publishedDecisionIds, txHashes);
        await this.submitWithSplitFallback(
          right,
          publishedDecisionIds,
          txHashes
        );
        return;
      }
      throw err;
    }
  }

  private buildNextOrderedBatch(): PendingOnChainDecision[] {
    // Group by feedId and sort each feed's queue strictly by sequenceNumber ascending
    const perFeedQueues = new Map<string, PendingOnChainDecision[]>();
    for (const d of this.pendingById.values()) {
      const list = perFeedQueues.get(d.feedId) ?? [];
      list.push(d);
      perFeedQueues.set(d.feedId, list);
    }

    for (const list of perFeedQueues.values()) {
      list.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    }

    // Order feeds so feeds with a high_payout_trigger head decision are scheduled first,
    // while strictly taking items in sequence order within each feed.
    const sortedFeeds = Array.from(perFeedQueues.keys()).sort((fA, fB) => {
      const headA = perFeedQueues.get(fA)![0]!;
      const headB = perFeedQueues.get(fB)![0]!;
      const prioA = headA.priority === "high_payout_trigger" ? 0 : 1;
      const prioB = headB.priority === "high_payout_trigger" ? 0 : 1;
      if (prioA !== prioB) return prioA - prioB;
      return headA.sequenceNumber - headB.sequenceNumber;
    });

    const batch: PendingOnChainDecision[] = [];
    let currentBytes = 0;

    for (const feedId of sortedFeeds) {
      const queue = perFeedQueues.get(feedId)!;
      for (const decision of queue) {
        if (batch.length >= this.maxBatchSize) break;
        if (
          batch.length > 0 &&
          currentBytes + decision.estimatedBytes > this.maxBatchBytes
        ) {
          // Stop adding from this feed so we never skip an earlier sequenceNumber for the same feed
          break;
        }
        batch.push(decision);
        currentBytes += decision.estimatedBytes;
      }
      if (batch.length >= this.maxBatchSize) break;
    }

    return batch;
  }
}
