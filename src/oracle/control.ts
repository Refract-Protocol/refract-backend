import { Inject, Injectable, Logger } from "@nestjs/common";
import { Pool } from "pg";
import { CacheService } from "../cache/cache.service";
import { COVERAGE_TYPE_CODE, CoverageTypeSoroban, codeToSoroban } from "../common/coverage-type.map";
import { DATABASE_POOL } from "../database/database.module";

export const GLOBAL_PAUSE_SCOPE = "global";

/** Scopes an operator can pause or resume: the global override plus each coverage type. */
export const PAUSE_SCOPES = [GLOBAL_PAUSE_SCOPE, ...Object.keys(COVERAGE_TYPE_CODE)] as const;
export type PauseScope = (typeof PAUSE_SCOPES)[number];

/** Postgres is the source of truth; this snapshot is only a cache of it. */
const PAUSE_STATE_CACHE_KEY = "oracle:pause-state";
/** Bounds how stale a cached snapshot can be if an invalidation is lost. */
const PAUSE_STATE_CACHE_TTL_SECONDS = 30;

export interface PauseState {
  paused: boolean;
  reason: string | null;
  actor: string | null;
  updatedAt: string | null;
}

interface PauseEntry extends PauseState {
  scope: string;
}

interface PauseStateRow {
  scope: string;
  paused: boolean;
  reason: string | null;
  actor: string | null;
  updated_at: Date;
}

export interface OracleStatus {
  global: PauseState;
  coverageTypes: Array<
    PauseState & {
      coverageType: CoverageTypeSoroban;
      id: number;
      /** True when this type is paused itself or the global override is active. */
      effectivelyPaused: boolean;
    }
  >;
}

export interface PauseChange {
  scope: PauseScope;
  paused: boolean;
  priorPaused: boolean;
  actor: string;
  reason: string;
  updatedAt: string;
}

const NOT_PAUSED: PauseState = { paused: false, reason: null, actor: null, updatedAt: null };

/**
 * Operator pause/resume for oracle-driven payouts. A paused coverage type is
 * still polled and logged by the claim scan; only settlement is skipped.
 */
@Injectable()
export class OracleControlService {
  private readonly logger = new Logger(OracleControlService.name);

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly cache: CacheService,
  ) {}

  /** True when the global override or the coverage type's own pause is active. */
  async isPaused(coverageCode: number): Promise<boolean> {
    const byScope = this.indexByScope(await this.loadEntries());
    return (
      byScope.get(GLOBAL_PAUSE_SCOPE)?.paused === true ||
      byScope.get(codeToSoroban(coverageCode))?.paused === true
    );
  }

  async getStatus(): Promise<OracleStatus> {
    const byScope = this.indexByScope(await this.loadEntries());
    const globalPaused = byScope.get(GLOBAL_PAUSE_SCOPE)?.paused === true;

    return {
      global: this.toPauseState(byScope.get(GLOBAL_PAUSE_SCOPE)),
      coverageTypes: (Object.entries(COVERAGE_TYPE_CODE) as Array<[CoverageTypeSoroban, number]>).map(
        ([coverageType, id]) => {
          const own = byScope.get(coverageType);
          return {
            coverageType,
            id,
            ...this.toPauseState(own),
            effectivelyPaused: globalPaused || own?.paused === true,
          };
        },
      ),
    };
  }

  /** Pauses or resumes one scope and appends an audit row in the same transaction. */
  async setPaused(scope: PauseScope, paused: boolean, actor: string, reason: string): Promise<PauseChange> {
    const client = await this.pool.connect();
    let change: PauseChange;
    try {
      await client.query("BEGIN");
      const prior = await client.query<{ paused: boolean }>(
        "SELECT paused FROM oracle_pause_state WHERE scope = $1 FOR UPDATE",
        [scope],
      );
      const priorPaused = prior.rows[0]?.paused ?? false;

      const state = await client.query<PauseStateRow>(
        `INSERT INTO oracle_pause_state (scope, paused, reason, actor, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (scope) DO UPDATE SET
           paused = EXCLUDED.paused,
           reason = EXCLUDED.reason,
           actor = EXCLUDED.actor,
           updated_at = EXCLUDED.updated_at
         RETURNING scope, paused, reason, actor, updated_at`,
        [scope, paused, reason, actor],
      );

      await client.query(
        `INSERT INTO oracle_pause_audit (scope, action, actor, reason, prior_paused)
         VALUES ($1, $2, $3, $4, $5)`,
        [scope, paused ? "pause" : "resume", actor, reason, priorPaused],
      );
      await client.query("COMMIT");

      change = {
        scope,
        paused,
        priorPaused,
        actor,
        reason,
        updatedAt: state.rows[0].updated_at.toISOString(),
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    await this.invalidateCache();
    this.logger.warn(
      `Oracle ${paused ? "pause" : "resume"}: scope=${scope} actor=${actor} prior_paused=${change.priorPaused}`,
    );
    return change;
  }

  /**
   * Reads the pause snapshot from Redis, falling back to Postgres on a miss or
   * a Redis failure. A Postgres failure propagates so settlement fails closed.
   */
  private async loadEntries(): Promise<PauseEntry[]> {
    try {
      const cached = await this.cache.get<PauseEntry[]>(PAUSE_STATE_CACHE_KEY);
      if (cached) return cached;
    } catch (err) {
      this.logger.warn(`Oracle pause cache read failed, using Postgres: ${(err as Error).message}`);
    }

    const rows = await this.pool.query<PauseStateRow>(
      "SELECT scope, paused, reason, actor, updated_at FROM oracle_pause_state",
    );
    const entries: PauseEntry[] = rows.rows.map((row) => ({
      scope: row.scope,
      paused: row.paused,
      reason: row.reason,
      actor: row.actor,
      updatedAt: row.updated_at.toISOString(),
    }));

    try {
      await this.cache.set(PAUSE_STATE_CACHE_KEY, entries, PAUSE_STATE_CACHE_TTL_SECONDS);
    } catch (err) {
      this.logger.warn(`Oracle pause cache write failed: ${(err as Error).message}`);
    }
    return entries;
  }

  private async invalidateCache(): Promise<void> {
    try {
      await this.cache.del(PAUSE_STATE_CACHE_KEY);
    } catch (err) {
      // The write is already durable; the TTL bounds how long the old snapshot survives.
      this.logger.error(`Oracle pause cache invalidation failed: ${(err as Error).message}`);
    }
  }

  private indexByScope(entries: PauseEntry[]): Map<string, PauseEntry> {
    return new Map(entries.map((entry) => [entry.scope, entry]));
  }

  private toPauseState(entry?: PauseState): PauseState {
    if (!entry) return { ...NOT_PAUSED };
    return { paused: entry.paused, reason: entry.reason, actor: entry.actor, updatedAt: entry.updatedAt };
  }
}
