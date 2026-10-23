import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
} from "@nestjs/common";
import { DrainResult, InFlightKind, InFlightTracker } from "./in-flight-tracker";
import { LeaderLock } from "./leader-lock";

export const ORACLE_LEADER_LOCK = Symbol("ORACLE_LEADER_LOCK");
export const ORACLE_SHUTDOWN_OPTIONS = Symbol("ORACLE_SHUTDOWN_OPTIONS");

export interface OracleShutdownOptions {
  /** How long shutdown waits for in-flight publishes and evidence writes. */
  drainDeadlineMs: number;
}

const DEFAULT_GRACE_MS = 30_000;
const DEFAULT_DRAIN_MS = 20_000;
/** Time left after the drain for releasing the lock and closing Postgres/Redis. */
const CLOSE_HEADROOM_MS = 5_000;

/**
 * Reads ORACLE_SHUTDOWN_DRAIN_MS and keeps it below main.ts's
 * SHUTDOWN_GRACE_PERIOD_MS, so the process's forced exit can never cut off
 * a drain halfway.
 */
export function loadOracleShutdownOptions(env: NodeJS.ProcessEnv = process.env): OracleShutdownOptions {
  const grace = Number(env.SHUTDOWN_GRACE_PERIOD_MS ?? DEFAULT_GRACE_MS);
  const requested = Number(env.ORACLE_SHUTDOWN_DRAIN_MS ?? DEFAULT_DRAIN_MS);
  const ceiling = Math.max(0, (Number.isFinite(grace) ? grace : DEFAULT_GRACE_MS) - CLOSE_HEADROOM_MS);
  const drain = Number.isFinite(requested) && requested >= 0 ? requested : DEFAULT_DRAIN_MS;
  return { drainDeadlineMs: Math.min(drain, ceiling) };
}

/**
 * Coordinates a clean stop of the oracle pipeline on SIGTERM/SIGINT.
 *
 * Nest's shutdown order is: onModuleDestroy → beforeApplicationShutdown →
 * onApplicationShutdown.
 *  1. onModuleDestroy: stop starting new polls (the scheduler also removes
 *     its cron job here).
 *  2. beforeApplicationShutdown: wait for in-flight polls, publishes and
 *     evidence writes, up to the deadline. Then release the leader lock.
 *  3. onApplicationShutdown: DbService and CacheService close Postgres and
 *     Redis, after the drain, so evidence writes still have a connection.
 */
@Injectable()
export class OraclePipelineLifecycle implements OnModuleDestroy, BeforeApplicationShutdown {
  private readonly logger = new Logger(OraclePipelineLifecycle.name);
  private readonly tracker = new InFlightTracker();
  private accepting = true;
  private lastDrain: DrainResult | null = null;

  constructor(
    @Inject(ORACLE_LEADER_LOCK) private readonly leaderLock: LeaderLock,
    @Inject(ORACLE_SHUTDOWN_OPTIONS) private readonly options: OracleShutdownOptions,
  ) {}

  isAccepting(): boolean {
    return this.accepting;
  }

  /**
   * Runs one poll if the pipeline is still accepting work and this replica
   * holds the leader lock. Returns false if the poll was skipped.
   */
  async runPoll(work: () => Promise<unknown>): Promise<boolean> {
    if (!this.accepting) return false;
    let leader = false;
    try {
      leader = await this.leaderLock.acquire();
    } catch (err) {
      this.logger.warn(`Leader lock unavailable, skipping poll: ${(err as Error).message}`);
      return false;
    }
    // Shutdown may have started while we were acquiring the lock.
    if (!leader || !this.accepting) return false;
    await this.tracker.track("poll", work, `poll@${new Date().toISOString()}`);
    return true;
  }

  /**
   * Tracks a publish or evidence write so shutdown waits for it. Still
   * accepted while draining, because a running poll must be able to finish.
   */
  track<T>(kind: Exclude<InFlightKind, "poll">, work: () => Promise<T>, id?: string): Promise<T> {
    if (!this.accepting) {
      this.logger.debug(`Tracking ${kind} started during shutdown drain`);
    }
    return this.tracker.track(kind, work, id);
  }

  inFlight(): number {
    return this.tracker.count();
  }

  lastDrainResult(): DrainResult | null {
    return this.lastDrain;
  }

  onModuleDestroy(): void {
    if (this.accepting) {
      this.accepting = false;
      this.logger.log("Oracle pipeline: no longer starting new polls");
    }
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.onModuleDestroy();
    const inFlight = this.tracker.count();
    this.logger.log(
      `Oracle pipeline draining${signal ? ` (${signal})` : ""}: ${inFlight} task(s) in flight, deadline ${this.options.drainDeadlineMs}ms`,
    );

    const result = await this.tracker.drain(this.options.drainDeadlineMs);
    this.lastDrain = result;
    if (result.drained) {
      this.logger.log(`Oracle pipeline drained in ${result.elapsedMs}ms`);
    } else {
      // Log every abandoned task with its id so the next start (or an
      // operator) can reconcile a publish without evidence, or the reverse.
      // main.ts exits non-zero when this happens.
      this.logger.error(
        `Oracle pipeline drain deadline (${this.options.drainDeadlineMs}ms) exceeded; abandoning ${JSON.stringify(result.pending)}`,
      );
      for (const task of result.abandoned) {
        this.logger.error(`Abandoned ${task.kind}${task.id ? ` ${task.id}` : ""} after ${task.runningMs}ms`);
      }
    }

    try {
      await this.leaderLock.release();
      this.logger.log("Oracle leader lock released");
    } catch (err) {
      this.logger.warn(`Failed to release oracle leader lock (it will expire by TTL): ${(err as Error).message}`);
    }
    try {
      await this.leaderLock.close();
    } catch (err) {
      this.logger.warn(`Failed to close leader lock connection: ${(err as Error).message}`);
    }
  }
}
