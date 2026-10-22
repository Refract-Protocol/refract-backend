import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

/**
 * Oracle Monitor
 *
 * Provides a cycle-completion hook that the oracle pipeline invokes after a
 * successful poll cycle AND a successful database write. The monitor is the
 * single source of truth for "completed work" signals in the pipeline.
 *
 * Issue #290: The dead-man's-switch heartbeat is driven exclusively by this
 * completed-work signal (never by a standalone timer). A wedged loop that
 * never finishes a cycle therefore stops heartbeating by construction.
 */

export interface CycleCompletionPayload {
  /** Number of feeds successfully polled in this cycle. */
  feedCount: number;
  /** Number of feeds that produced a fresh value in this cycle. */
  coveredFeedCount: number;
  /** Total number of configured feeds. */
  totalFeedCount: number;
  /** Timestamp (ms since epoch) of the last successful publish. */
  lastSuccessfulPublishAt: number | null;
  /** Timestamp (ms since epoch) at which this cycle completed. */
  cycleCompletedAt: number;
}

export type CycleCompletionHook = (
  payload: CycleCompletionPayload,
) => void | Promise<void>;

export interface OracleMonitorOptions {
  /** Optional clock injection for tests. */
  now?: () => number;
}

/**
 * OracleMonitor tracks pipeline cycle completions and fans out a
 * completed-work signal to registered hooks (e.g. the heartbeat service).
 */
export class OracleMonitor extends EventEmitter {
  private readonly now: () => number;
  private readonly hooks: Set<CycleCompletionHook> = new Set();
  private lastCycleCompletedAt: number | null = null;
  private lastSuccessfulPublishAt: number | null = null;
  private lastPayload: CycleCompletionPayload | null = null;

  constructor(options: OracleMonitorOptions = {}) {
    super();
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Register a hook invoked after every successful cycle completion.
   * Returns an unsubscribe function.
   */
  public onCycleComplete(hook: CycleCompletionHook): () => void {
    this.hooks.add(hook);
    return () => {
      this.hooks.delete(hook);
    };
  }

  /**
   * Record a successful poll cycle + successful DB write.
   *
   * This is the ONLY entry point that triggers the heartbeat. It must be
   * called after both the poll cycle and the DB write have succeeded.
   */
  public async recordCycleCompletion(input: {
    feedCount: number;
    coveredFeedCount: number;
    totalFeedCount: number;
    lastSuccessfulPublishAt?: number | null;
  }): Promise<void> {
    const cycleCompletedAt = this.now();

    if (
      typeof input.lastSuccessfulPublishAt === 'number' &&
      Number.isFinite(input.lastSuccessfulPublishAt)
    ) {
      this.lastSuccessfulPublishAt = input.lastSuccessfulPublishAt;
    }

    const payload: CycleCompletionPayload = {
      feedCount: input.feedCount,
      coveredFeedCount: input.coveredFeedCount,
      totalFeedCount: input.totalFeedCount,
      lastSuccessfulPublishAt: this.lastSuccessfulPublishAt,
      cycleCompletedAt,
    };

    this.lastCycleCompletedAt = cycleCompletedAt;
    this.lastPayload = payload;

    this.emit('cycleComplete', payload);

    // Fan out to hooks. Hooks must never throw synchronously into the
    // pipeline; failures are logged and swallowed so a broken hook cannot
    // take down the oracle loop.
    for (const hook of this.hooks) {
      try {
        await hook(payload);
      } catch (err) {
        logger.error('oracleMonitor: cycle completion hook failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Timestamp of the last completed cycle, or null if none yet. */
  public getLastCycleCompletedAt(): number | null {
    return this.lastCycleCompletedAt;
  }

  /** Timestamp of the last successful publish, or null if none yet. */
  public getLastSuccessfulPublishAt(): number | null {
    return this.lastSuccessfulPublishAt;
  }

  /** The most recent cycle-completion payload, or null if none yet. */
  public getLastPayload(): CycleCompletionPayload | null {
    return this.lastPayload;
  }
}

export default OracleMonitor;