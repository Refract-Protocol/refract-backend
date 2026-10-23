import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { DatabaseService } from "../db/database.service";
import {
  CreateFeedInput,
  FeedDefinition,
  UpdateFeedInput,
  feedDefinitionSchema,
} from "./feed-definition.schema";

export interface FeedDefinitionRecord {
  feedKey: string;
  version: number;
  definition: FeedDefinition;
  previousDefinition: FeedDefinition | null;
  changeType: "create" | "update";
  changedBy: string;
  changedAt: string;
}

const DEFAULT_RELOAD_INTERVAL_MS = 15_000;
const UNIQUE_VIOLATION = "23505";

/**
 * Source of truth for oracle feed definitions is the append-only
 * `oracle_feed_definitions` table. This service writes new versions, serves
 * admin reads from the database, and keeps an in-process copy of the latest
 * version of every feed for the monitor.
 *
 * The monitor's copy is refreshed every FEED_DEFINITIONS_RELOAD_MS (default
 * 15 s), so a policy change reaches every instance within one interval. Writes
 * on this instance refresh immediately.
 */
@Injectable()
export class FeedDefinitionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FeedDefinitionsService.name);
  private readonly reloadIntervalMs = Number(process.env.FEED_DEFINITIONS_RELOAD_MS) || DEFAULT_RELOAD_INTERVAL_MS;
  private cache = new Map<string, FeedDefinitionRecord>();
  private reloadTimer?: NodeJS.Timeout;

  constructor(private readonly db: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    await this.safeRefresh();
    this.reloadTimer = setInterval(() => void this.safeRefresh(), this.reloadIntervalMs);
    this.reloadTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.reloadTimer);
  }

  /** Latest version of every feed that is enabled. Used by the monitor. */
  getEnabledFeeds(): FeedDefinitionRecord[] {
    return [...this.cache.values()].filter((record) => record.definition.enabled);
  }

  getCachedFeed(feedKey: string): FeedDefinitionRecord | undefined {
    return this.cache.get(feedKey);
  }

  async listLatest(): Promise<FeedDefinitionRecord[]> {
    const result = await this.db.query<FeedRow>(
      `SELECT DISTINCT ON (feed_key) feed_key, version, definition, previous_definition,
              change_type, changed_by, changed_at
         FROM oracle_feed_definitions
        ORDER BY feed_key, version DESC`,
    );
    return result.rows.map(toRecord);
  }

  async getLatest(feedKey: string): Promise<FeedDefinitionRecord> {
    const result = await this.db.query<FeedRow>(
      `SELECT feed_key, version, definition, previous_definition, change_type, changed_by, changed_at
         FROM oracle_feed_definitions
        WHERE feed_key = $1
        ORDER BY version DESC
        LIMIT 1`,
      [feedKey],
    );
    if (result.rows.length === 0) {
      throw new NotFoundException({ code: "FEED_NOT_FOUND", error: `Feed ${feedKey} does not exist.` });
    }
    return toRecord(result.rows[0]);
  }

  /** Full version history of one feed, newest first, so past decisions can be explained. */
  async listVersions(feedKey: string): Promise<FeedDefinitionRecord[]> {
    const result = await this.db.query<FeedRow>(
      `SELECT feed_key, version, definition, previous_definition, change_type, changed_by, changed_at
         FROM oracle_feed_definitions
        WHERE feed_key = $1
        ORDER BY version DESC`,
      [feedKey],
    );
    if (result.rows.length === 0) {
      throw new NotFoundException({ code: "FEED_NOT_FOUND", error: `Feed ${feedKey} does not exist.` });
    }
    return result.rows.map(toRecord);
  }

  async create(input: CreateFeedInput, actor: string): Promise<FeedDefinitionRecord> {
    const { feedKey, ...definition } = input;
    const record = await this.insertVersion(feedKey, 1, definition, null, "create", actor);
    await this.safeRefresh();
    return record;
  }

  async update(feedKey: string, input: UpdateFeedInput, actor: string): Promise<FeedDefinitionRecord> {
    const { expectedVersion, ...changes } = input;
    const current = await this.getLatest(feedKey);
    if (current.version !== expectedVersion) {
      throw new ConflictException({
        code: "FEED_VERSION_CONFLICT",
        error: `Feed ${feedKey} is at version ${current.version}, not ${expectedVersion}. Reload and retry.`,
        currentVersion: current.version,
      });
    }

    // Validate the merged result, not the patch alone. Feasibility is a
    // property of the whole definition (e.g. disabling a source can break quorum).
    const merged = feedDefinitionSchema.safeParse({ ...current.definition, ...changes });
    if (!merged.success) {
      throw new BadRequestException({
        code: "FEED_INVALID",
        error: "Updated feed definition is invalid.",
        issues: merged.error.issues,
      });
    }

    const record = await this.insertVersion(
      feedKey,
      current.version + 1,
      merged.data,
      current.definition,
      "update",
      actor,
    );
    await this.safeRefresh();
    return record;
  }

  /**
   * Inserts one version. The (feed_key, version) primary key rejects a racing
   * writer that picked the same next version, which is surfaced as a conflict.
   */
  private async insertVersion(
    feedKey: string,
    version: number,
    definition: FeedDefinition,
    previousDefinition: FeedDefinition | null,
    changeType: "create" | "update",
    actor: string,
  ): Promise<FeedDefinitionRecord> {
    try {
      const result = await this.db.query<FeedRow>(
        `INSERT INTO oracle_feed_definitions
           (feed_key, version, definition, previous_definition, change_type, changed_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING feed_key, version, definition, previous_definition, change_type, changed_by, changed_at`,
        [feedKey, version, JSON.stringify(definition), previousDefinition ? JSON.stringify(previousDefinition) : null, changeType, actor],
      );
      return toRecord(result.rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new ConflictException({
          code: changeType === "create" ? "FEED_ALREADY_EXISTS" : "FEED_VERSION_CONFLICT",
          error: `Feed ${feedKey} was changed concurrently. Reload and retry.`,
        });
      }
      throw err;
    }
  }

  private async safeRefresh(): Promise<void> {
    try {
      const records = await this.listLatest();
      this.cache = new Map(records.map((record) => [record.feedKey, record]));
    } catch (err) {
      // Keep serving the last good snapshot; the next interval retries.
      this.logger.warn(`Feed definition reload failed: ${(err as Error).message}`);
    }
  }
}

interface FeedRow {
  feed_key: string;
  version: number;
  definition: FeedDefinition;
  previous_definition: FeedDefinition | null;
  change_type: "create" | "update";
  changed_by: string;
  changed_at: Date;
}

function toRecord(row: FeedRow): FeedDefinitionRecord {
  return {
    feedKey: row.feed_key,
    version: row.version,
    definition: row.definition,
    previousDefinition: row.previous_definition,
    changeType: row.change_type,
    changedBy: row.changed_by,
    changedAt: row.changed_at.toISOString(),
  };
}
