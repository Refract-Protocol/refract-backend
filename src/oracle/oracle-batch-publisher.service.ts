import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { MetricsService } from "../metrics/metrics.service";
import { scaleOracleValue } from "./oracle-encoding";
import { OraclePublishQueueRepository, PendingDecision } from "./oracle-publish-queue.repository";
import { OracleReading } from "./oracle-reading";

export const ORACLE_BATCH_SUBMITTER = Symbol("ORACLE_BATCH_SUBMITTER");

export interface BatchSubmitResult {
  txHash: string;
  ledger: number | null;
}

export type TxLookup = { status: "success"; ledger: number | null } | { status: "pending" | "failed" | "not_found" };

/**
 * Soroban-facing side of the pipeline (wraps RelayerAccountService /
 * SorobanRpcService). `submit` receives decisions already in publish order and
 * must apply them in that order. It resolves only once the tx is confirmed.
 */
export interface OracleBatchSubmitter {
  submit(batch: PendingDecision[]): Promise<BatchSubmitResult>;
  /** Used to reconcile a submission whose outcome is unknown (RPC timeout). */
  lookup(txHash: string): Promise<TxLookup>;
}

/** Tx exceeded Soroban size/resource limits or fee ceiling: split the batch. */
export class BatchTooLargeError extends Error {
  readonly name = "BatchTooLargeError";
}

/** Outcome unknown (e.g. timeout after send): never resubmit before reconciling `txHash`. */
export class AmbiguousSubmitError extends Error {
  readonly name = "AmbiguousSubmitError";
  constructor(message: string, readonly txHash: string) {
    super(message);
  }
}

export interface OracleBatchPublisherOptions {
  maxBatchSize: number;
  maxInFlight: number;
  /** Max decisions one feed may contribute to a single batch (fair scheduling). */
  maxPerFeedPerBatch: number;
  tickIntervalMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Decisions that fail this many times are dead-lettered instead of retried forever. */
  maxAttempts: number;
  backpressureQueueDepth: number;
  backpressureRpcLatencyMs: number;
  /** Low-priority polling is slowed by this factor while backpressure is active. */
  lowPriorityPollMultiplier: number;
}

const envInt = (name: string, fallback: number): number => {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function defaultPublisherOptions(): OracleBatchPublisherOptions {
  return {
    maxBatchSize: envInt("ORACLE_PUBLISH_MAX_BATCH_SIZE", 20),
    maxInFlight: envInt("ORACLE_PUBLISH_MAX_IN_FLIGHT", 2),
    maxPerFeedPerBatch: envInt("ORACLE_PUBLISH_MAX_PER_FEED_PER_BATCH", 5),
    tickIntervalMs: envInt("ORACLE_PUBLISH_TICK_MS", 500),
    baseBackoffMs: envInt("ORACLE_PUBLISH_BASE_BACKOFF_MS", 1_000),
    maxBackoffMs: envInt("ORACLE_PUBLISH_MAX_BACKOFF_MS", 60_000),
    maxAttempts: envInt("ORACLE_PUBLISH_MAX_ATTEMPTS", 10),
    backpressureQueueDepth: envInt("ORACLE_PUBLISH_BACKPRESSURE_QUEUE_DEPTH", 200),
    backpressureRpcLatencyMs: envInt("ORACLE_PUBLISH_BACKPRESSURE_RPC_LATENCY_MS", 5_000),
    lowPriorityPollMultiplier: envInt("ORACLE_PUBLISH_LOW_PRIORITY_POLL_MULTIPLIER", 4),
  };
}

export const ORACLE_BATCH_PUBLISHER_OPTIONS = Symbol("ORACLE_BATCH_PUBLISHER_OPTIONS");

/**
 * Persist-then-publish oracle pipeline. Producers call `enqueue` (a durable
 * insert); a single-flight loop owns submission, packing ordered batches
 * (bounded by `maxBatchSize` / `maxInFlight`), retrying with jittered backoff,
 * and splitting batches on size/fee errors. A feed never has more than one
 * batch in flight, so later decisions cannot land before earlier ones.
 */
@Injectable()
export class OracleBatchPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OracleBatchPublisherService.name);
  private readonly inFlight = new Set<Promise<void>>();
  private readonly feedsInFlight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private smoothedRpcLatencyMs = 0;
  private backpressure = false;
  private queueDepth = { high: 0, low: 0 };

  constructor(
    private readonly queue: OraclePublishQueueRepository,
    @Inject(ORACLE_BATCH_SUBMITTER) private readonly submitter: OracleBatchSubmitter,
    private readonly metrics: MetricsService,
    @Inject(ORACLE_BATCH_PUBLISHER_OPTIONS) private readonly options: OracleBatchPublisherOptions
  ) {}

  async onModuleInit(): Promise<void> {
    const recovered = await this.queue.recoverInflight();
    if (recovered > 0) this.logger.warn(`Recovered ${recovered} in-flight oracle decision(s) after restart`);
    this.stopped = false;
    this.schedule();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await Promise.allSettled([...this.inFlight]);
  }

  /** Producer entry point: durable insert only; never touches the RPC. */
  async enqueue(reading: OracleReading, decisionKey: string): Promise<boolean> {
    if (reading.degraded) return false;
    return this.queue.enqueue({
      decisionKey,
      feed: reading.coverageType,
      valueScaled: scaleOracleValue(reading.coverageType, reading.value),
      priority: reading.severity === "triggered" || reading.severity === "high" ? 1 : 0,
    });
  }

  isBackpressured(): boolean {
    return this.backpressure;
  }

  /**
   * Multiplier the poller should apply to a feed's interval. Payout-triggering
   * (high-priority) feeds are never slowed.
   */
  pollIntervalMultiplier(priority: "high" | "low"): number {
    if (priority === "high" || !this.backpressure) return 1;
    return this.options.lowPriorityPollMultiplier;
  }

  /** Runs one scheduling pass: refresh pressure, then fill free in-flight slots. */
  async tick(): Promise<void> {
    await this.refreshPressure();
    while (this.inFlight.size < this.options.maxInFlight) {
      const batch = await this.queue.claim(
        this.options.maxBatchSize,
        this.options.maxPerFeedPerBatch,
        [...this.feedsInFlight]
      );
      if (batch.length === 0) return;
      const feeds = [...new Set(batch.map((d) => d.feed))];
      feeds.forEach((f) => this.feedsInFlight.add(f));
      const run: Promise<void> = this.process(batch)
        .catch((err) => this.logger.error(`Unhandled publisher error: ${errMsg(err)}`))
        .finally(() => {
          feeds.forEach((f) => this.feedsInFlight.delete(f));
          this.inFlight.delete(run);
        });
      this.inFlight.add(run);
    }
  }

  /** Resolves when every batch currently in flight has settled (used by tests / shutdown). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      if (this.running) return this.schedule();
      this.running = true;
      this.tick()
        .catch((err) => this.logger.error(`Oracle publisher tick failed: ${errMsg(err)}`))
        .finally(() => {
          this.running = false;
          this.schedule();
        });
    }, this.options.tickIntervalMs);
  }

  private async refreshPressure(): Promise<void> {
    try {
      this.queueDepth = await this.queue.depth();
    } catch (err) {
      this.logger.warn(`Could not read oracle publish queue depth: ${errMsg(err)}`);
    }
    const depth = this.queueDepth.high + this.queueDepth.low;
    const active =
      depth > this.options.backpressureQueueDepth ||
      this.smoothedRpcLatencyMs > this.options.backpressureRpcLatencyMs;
    if (active !== this.backpressure) {
      this.logger.warn(
        active
          ? `Oracle publish backpressure ON (queue depth ${depth}, rpc latency ${Math.round(this.smoothedRpcLatencyMs)}ms): ` +
              `low-priority polling slowed x${this.options.lowPriorityPollMultiplier}`
          : "Oracle publish backpressure OFF"
      );
    }
    this.backpressure = active;
    this.metrics.recordOraclePublishState({
      depthHigh: this.queueDepth.high,
      depthLow: this.queueDepth.low,
      backpressure: active,
      rpcLatencySeconds: this.smoothedRpcLatencyMs / 1000,
    });
  }

  /**
   * Publishes an ordered batch. On a size/fee error the batch is split in two
   * and the halves are published sequentially (first half first), so order is
   * kept. Anything not confirmed is released back to the queue, never dropped.
   */
  private async process(batch: PendingDecision[]): Promise<void> {
    const reconciled = await this.reconcile(batch);
    if (reconciled === null) return;
    batch = reconciled;
    if (batch.length === 0) return;

    const startedAt = Date.now();
    try {
      const result = await this.submitter.submit(batch);
      this.observeLatency(Date.now() - startedAt);
      await this.queue.markPublished(batch.map((d) => d.id), result.txHash, result.ledger);
      this.metrics.recordOraclePublishDecisions("published", batch.length);
    } catch (err) {
      this.observeLatency(Date.now() - startedAt);
      await this.handleFailure(batch, err);
    }
  }

  /**
   * Decisions that carry a tx hash from an ambiguous earlier attempt are
   * checked on-chain first so a timeout never produces a duplicate publish.
   * Returns the decisions that still need submitting, or null if the whole
   * batch was deferred (the tx may still be pending).
   */
  private async reconcile(batch: PendingDecision[]): Promise<PendingDecision[] | null> {
    const hashes = [...new Set(batch.map((d) => d.txHash).filter((h): h is string => !!h))];
    if (hashes.length === 0) return batch;

    const done = new Set<string>();
    for (const hash of hashes) {
      let lookup: TxLookup;
      try {
        lookup = await this.submitter.lookup(hash);
      } catch (err) {
        await this.retryLater(batch, `reconcile ${hash} failed: ${errMsg(err)}`);
        return null;
      }
      if (lookup.status === "pending") {
        await this.retryLater(batch, `tx ${hash} still pending`, false);
        return null;
      }
      if (lookup.status === "success") {
        const ids = batch.filter((d) => d.txHash === hash).map((d) => d.id);
        await this.queue.markPublished(ids, hash, lookup.ledger);
        this.metrics.recordOraclePublishDecisions("published", ids.length);
        ids.forEach((id) => done.add(id));
      }
    }
    const remaining = batch.filter((d) => !done.has(d.id));
    // A later decision may not be submitted if an earlier one in its feed is unresolved.
    return remaining;
  }

  private async handleFailure(batch: PendingDecision[], err: unknown): Promise<void> {
    if (err instanceof BatchTooLargeError || isSizeOrFeeError(err)) {
      if (batch.length === 1) {
        this.logger.error(`Oracle decision ${batch[0].decisionKey} exceeds tx limits on its own; dead-lettering`);
        await this.queue.markFailed([batch[0].id], errMsg(err));
        this.metrics.recordOraclePublishDecisions("failed", 1);
        return;
      }
      const mid = Math.ceil(batch.length / 2);
      this.logger.warn(`Splitting oracle batch of ${batch.length} after size/fee error: ${errMsg(err)}`);
      this.metrics.recordOraclePublishDecisions("split", batch.length);
      const head = batch.slice(0, mid);
      const tail = batch.slice(mid);
      await this.processSplit(head, tail);
      return;
    }
    const hash = err instanceof AmbiguousSubmitError ? err.txHash : undefined;
    await this.retryLater(batch, errMsg(err), true, hash);
  }

  /** Publishes `head` then `tail`; if `head` does not confirm, `tail` is released untouched. */
  private async processSplit(head: PendingDecision[], tail: PendingDecision[]): Promise<void> {
    const outcome = await this.publishOrRelease(head);
    if (outcome === "published") {
      await this.process(tail);
    } else {
      await this.queue.release(tail.map((d) => d.id), 0, "released: earlier split half did not confirm");
    }
  }

  private async publishOrRelease(batch: PendingDecision[]): Promise<"published" | "deferred"> {
    const startedAt = Date.now();
    try {
      const result = await this.submitter.submit(batch);
      this.observeLatency(Date.now() - startedAt);
      await this.queue.markPublished(batch.map((d) => d.id), result.txHash, result.ledger);
      this.metrics.recordOraclePublishDecisions("published", batch.length);
      return "published";
    } catch (err) {
      this.observeLatency(Date.now() - startedAt);
      if ((err instanceof BatchTooLargeError || isSizeOrFeeError(err)) && batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        this.metrics.recordOraclePublishDecisions("split", batch.length);
        const first = await this.publishOrRelease(batch.slice(0, mid));
        if (first === "deferred") {
          await this.queue.release(batch.slice(mid).map((d) => d.id), 0, "released: earlier split half did not confirm");
          return "deferred";
        }
        return this.publishOrRelease(batch.slice(mid));
      }
      if (err instanceof BatchTooLargeError || isSizeOrFeeError(err)) {
        await this.queue.markFailed([batch[0].id], errMsg(err));
        this.metrics.recordOraclePublishDecisions("failed", 1);
        return "published"; // dead-lettered; do not block the rest of the feed forever
      }
      await this.retryLater(batch, errMsg(err), true, err instanceof AmbiguousSubmitError ? err.txHash : undefined);
      return "deferred";
    }
  }

  private async retryLater(batch: PendingDecision[], reason: string, countAttempt = true, txHash?: string): Promise<void> {
    const exhausted = countAttempt ? batch.filter((d) => d.attempts >= this.options.maxAttempts) : [];
    const retryable = batch.filter((d) => !exhausted.includes(d));
    if (exhausted.length > 0) {
      this.logger.error(`Dead-lettering ${exhausted.length} oracle decision(s) after ${this.options.maxAttempts} attempts: ${reason}`);
      await this.queue.markFailed(exhausted.map((d) => d.id), reason);
      this.metrics.recordOraclePublishDecisions("failed", exhausted.length);
    }
    if (retryable.length === 0) return;
    const attempts = Math.max(...retryable.map((d) => d.attempts));
    const delay = jitteredBackoff(attempts, this.options.baseBackoffMs, this.options.maxBackoffMs);
    this.logger.warn(`Oracle batch of ${retryable.length} not published (${reason}); retrying in ${delay}ms`);
    await this.queue.release(retryable.map((d) => d.id), delay, reason, txHash);
    this.metrics.recordOraclePublishDecisions("retried", retryable.length);
  }

  private observeLatency(ms: number): void {
    this.smoothedRpcLatencyMs = this.smoothedRpcLatencyMs === 0 ? ms : this.smoothedRpcLatencyMs * 0.7 + ms * 0.3;
  }
}

/** Full-jitter exponential backoff: uniform in [cap/2, cap] where cap = min(max, base * 2^(attempt-1)). */
export function jitteredBackoff(attempt: number, baseMs: number, maxMs: number, random = Math.random): number {
  const cap = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(cap / 2 + random() * (cap / 2));
}

function isSizeOrFeeError(err: unknown): boolean {
  return /exceeds? .*(size|limit)|tx_?too_?big|resource limit|insufficient.?fee|fee.*(exceed|ceiling)/i.test(errMsg(err));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
