import { OracleConfigFile, OracleFeedDefinition } from "../config/oracle-feed-config";
import { OracleConfigIssue, validateOracleConfig } from "../config/oracle-config.validator";
import { TRUST_MODES } from "../config/oracle-feed-config";
import { currentActor, recordAuditChange } from "./oracle-audit";

export class ControlNotFoundError extends Error {}
export class ControlConflictError extends Error {}
export class ControlValidationError extends Error {
  constructor(
    message: string,
    readonly issues: OracleConfigIssue[] = []
  ) {
    super(message);
  }
}

export interface Stamp {
  by: string;
  at: string;
}

export interface PauseState extends Stamp {
  paused: boolean;
  reason: string | null;
}

export interface QuarantineOverride extends Stamp {
  /** `quarantine` forces a source out; `release` forces a quarantined source back in. */
  action: "quarantine" | "release";
  reason: string;
  expiresAt: string | null;
}

export interface ManualOverride extends Stamp {
  value: number;
  reason: string;
  expiresAt: string;
}

export interface FeedView {
  definition: OracleFeedDefinition;
  revision: number;
  updatedBy: string;
  updatedAt: string;
  pause: PauseState | null;
  quarantineOverrides: Record<string, QuarantineOverride>;
  manualOverride: ManualOverride | null;
}

export interface MutationResult<T> {
  value: T;
  /** Validator warnings for the new state; errors block the change instead. */
  warnings: OracleConfigIssue[];
}

/** Manual value overrides must expire within this window, so a forgotten one cannot pin a feed forever. */
export const MAX_MANUAL_OVERRIDE_MS = 24 * 60 * 60 * 1000;

interface FeedRecord {
  definition: OracleFeedDefinition;
  revision: number;
  updatedBy: string;
  updatedAt: string;
}

export interface RegistryOptions {
  network: string;
  now?: () => number;
  /** Called with sources that a create or update added, so they can be bootstrapped. */
  onSourcesAdded?: (feedId: string, sources: OracleFeedDefinition["sources"]) => void;
}

const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

/**
 * Operator-controlled oracle state: feed definitions and quorum policy, plus
 * the runtime controls layered on top (pause, quarantine overrides, manual
 * value overrides).
 *
 * Every definition change is validated with the startup rules
 * (validateOracleConfig) against the whole feed set, so the API cannot
 * create a config the process would refuse to boot with. Every change is
 * stamped with the acting operator from the audit context and recorded as a
 * before/after change on the request's audit event.
 *
 * Pollers and publishers read the controls through isPaused,
 * quarantineOverride, and activeManualOverride.
 */
export class OracleControlRegistry {
  private readonly defaults: OracleConfigFile["defaults"];
  private readonly feeds = new Map<string, FeedRecord>();
  private readonly pauses = new Map<string, PauseState>();
  private readonly quarantine = new Map<string, Map<string, QuarantineOverride>>();
  private readonly manual = new Map<string, ManualOverride>();
  private readonly now: () => number;

  constructor(
    config: OracleConfigFile,
    private readonly options: RegistryOptions
  ) {
    this.now = options.now ?? Date.now;
    this.defaults = clone(config.defaults);
    const at = this.timestamp();
    for (const feed of config.feeds) {
      this.feeds.set(feed.id, { definition: clone(feed), revision: 1, updatedBy: "config", updatedAt: at });
    }
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  listFeeds(): FeedView[] {
    return [...this.feeds.keys()].sort().map((id) => this.view(id));
  }

  getFeed(feedId: string): FeedView {
    this.require(feedId);
    return this.view(feedId);
  }

  isPaused(feedId: string): boolean {
    return this.pauses.get(feedId)?.paused ?? false;
  }

  quarantineOverride(feedId: string, sourceId: string): QuarantineOverride | null {
    const override = this.quarantine.get(feedId)?.get(sourceId);
    if (!override) return null;
    if (override.expiresAt && Date.parse(override.expiresAt) <= this.now()) return null;
    return clone(override);
  }

  activeManualOverride(feedId: string): ManualOverride | null {
    const override = this.manual.get(feedId);
    if (!override || Date.parse(override.expiresAt) <= this.now()) return null;
    return clone(override);
  }

  // ── Feed definitions and quorum policy ────────────────────────────────

  upsertFeed(
    feedId: string,
    definition: OracleFeedDefinition,
    expectedRevision?: number
  ): MutationResult<FeedView> {
    if (definition.id !== feedId) {
      throw new ControlValidationError(`Body id "${definition.id}" does not match path id "${feedId}"`);
    }
    const existing = this.feeds.get(feedId);
    this.checkRevision(feedId, existing, expectedRevision);

    const warnings = this.validateWith(feedId, definition);
    const before = existing ? clone(existing.definition) : null;
    this.feeds.set(feedId, {
      definition: clone(definition),
      revision: (existing?.revision ?? 0) + 1,
      ...this.stamp(),
    });
    recordAuditChange({ entity: "feed", id: feedId, before, after: clone(definition) });

    // Drop overrides that point at sources the new definition removed.
    const sourceIds = new Set(definition.sources.map((s) => s.id));
    for (const sourceId of this.quarantine.get(feedId)?.keys() ?? []) {
      if (!sourceIds.has(sourceId)) this.quarantine.get(feedId)?.delete(sourceId);
    }

    const previousIds = new Set(before?.sources.map((s) => s.id) ?? []);
    const added = definition.sources.filter((s) => !previousIds.has(s.id) && s.enabled !== false);
    if (added.length > 0) this.options.onSourcesAdded?.(feedId, clone(added));

    return { value: this.view(feedId), warnings };
  }

  deleteFeed(feedId: string, expectedRevision?: number): MutationResult<null> {
    const existing = this.require(feedId);
    this.checkRevision(feedId, existing, expectedRevision);
    const warnings = this.validateWith(feedId, null);

    this.feeds.delete(feedId);
    this.pauses.delete(feedId);
    this.quarantine.delete(feedId);
    this.manual.delete(feedId);
    recordAuditChange({ entity: "feed", id: feedId, before: clone(existing.definition), after: null });
    return { value: null, warnings };
  }

  updateQuorum(
    feedId: string,
    change: { trustMode?: string; minSources: number; maxDeviationBps?: number },
    expectedRevision?: number
  ): MutationResult<FeedView> {
    const existing = this.require(feedId);
    if (change.trustMode !== undefined && !(TRUST_MODES as readonly string[]).includes(change.trustMode)) {
      throw new ControlValidationError(`trustMode must be one of ${TRUST_MODES.join(", ")}`);
    }
    const definition: OracleFeedDefinition = {
      ...clone(existing.definition),
      ...(change.trustMode !== undefined ? { trustMode: change.trustMode } : {}),
      quorum: {
        minSources: change.minSources,
        ...(change.maxDeviationBps !== undefined
          ? { maxDeviationBps: change.maxDeviationBps }
          : existing.definition.quorum?.maxDeviationBps !== undefined
            ? { maxDeviationBps: existing.definition.quorum.maxDeviationBps }
            : {}),
      },
    };
    this.checkRevision(feedId, existing, expectedRevision);
    const warnings = this.validateWith(feedId, definition);

    this.feeds.set(feedId, { definition, revision: existing.revision + 1, ...this.stamp() });
    recordAuditChange({
      entity: "quorum",
      id: feedId,
      before: { trustMode: existing.definition.trustMode, quorum: existing.definition.quorum },
      after: { trustMode: definition.trustMode, quorum: definition.quorum },
    });
    return { value: this.view(feedId), warnings };
  }

  // ── Runtime controls ───────────────────────────────────────────────────

  pause(feedId: string, reason: string): PauseState {
    this.require(feedId);
    return this.setPause(feedId, { paused: true, reason });
  }

  resume(feedId: string, reason: string | null): PauseState {
    this.require(feedId);
    return this.setPause(feedId, { paused: false, reason });
  }

  setQuarantineOverride(
    feedId: string,
    sourceId: string,
    override: { action: "quarantine" | "release"; reason: string; expiresAt?: string | null }
  ): QuarantineOverride {
    const feed = this.require(feedId);
    if (!feed.definition.sources.some((s) => s.id === sourceId)) {
      throw new ControlNotFoundError(`Feed "${feedId}" has no source "${sourceId}"`);
    }
    if (override.expiresAt && Date.parse(override.expiresAt) <= this.now()) {
      throw new ControlValidationError("expiresAt must be in the future");
    }

    const bySource = this.quarantine.get(feedId) ?? new Map<string, QuarantineOverride>();
    const before = bySource.get(sourceId) ?? null;
    const next: QuarantineOverride = {
      action: override.action,
      reason: override.reason,
      expiresAt: override.expiresAt ?? null,
      ...this.stampAt(),
    };
    bySource.set(sourceId, next);
    this.quarantine.set(feedId, bySource);
    recordAuditChange({ entity: "quarantine_override", id: `${feedId}/${sourceId}`, before, after: next });
    return clone(next);
  }

  clearQuarantineOverride(feedId: string, sourceId: string): void {
    this.require(feedId);
    const before = this.quarantine.get(feedId)?.get(sourceId);
    if (!before) throw new ControlNotFoundError(`No quarantine override for ${feedId}/${sourceId}`);
    this.quarantine.get(feedId)?.delete(sourceId);
    recordAuditChange({ entity: "quarantine_override", id: `${feedId}/${sourceId}`, before, after: null });
  }

  setManualOverride(feedId: string, override: { value: number; reason: string; expiresAt: string }): ManualOverride {
    this.require(feedId);
    const expiresAt = Date.parse(override.expiresAt);
    if (!Number.isFinite(override.value)) {
      throw new ControlValidationError("value must be a finite number");
    }
    if (Number.isNaN(expiresAt) || expiresAt <= this.now()) {
      throw new ControlValidationError("expiresAt must be a future ISO-8601 timestamp");
    }
    if (expiresAt - this.now() > MAX_MANUAL_OVERRIDE_MS) {
      throw new ControlValidationError("Manual overrides may last at most 24 hours");
    }

    const before = this.manual.get(feedId) ?? null;
    const next: ManualOverride = {
      value: override.value,
      reason: override.reason,
      expiresAt: new Date(expiresAt).toISOString(),
      ...this.stampAt(),
    };
    this.manual.set(feedId, next);
    recordAuditChange({ entity: "manual_override", id: feedId, before, after: next });
    return clone(next);
  }

  clearManualOverride(feedId: string): void {
    this.require(feedId);
    const before = this.manual.get(feedId);
    if (!before) throw new ControlNotFoundError(`No manual override for ${feedId}`);
    this.manual.delete(feedId);
    recordAuditChange({ entity: "manual_override", id: feedId, before, after: null });
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private setPause(feedId: string, state: { paused: boolean; reason: string | null }): PauseState {
    const before = this.pauses.get(feedId) ?? null;
    const next: PauseState = { ...state, ...this.stampAt() };
    this.pauses.set(feedId, next);
    recordAuditChange({ entity: "pause", id: feedId, before, after: next });
    return clone(next);
  }

  /** Validates the full feed set with `feedId` replaced (or removed when `definition` is null). */
  private validateWith(feedId: string, definition: OracleFeedDefinition | null): OracleConfigIssue[] {
    const feeds = [...this.feeds.entries()]
      .filter(([id]) => id !== feedId)
      .map(([, record]) => record.definition);
    if (definition) feeds.push(definition);

    const report = validateOracleConfig(
      { version: 1, defaults: this.defaults, feeds },
      { network: this.options.network }
    );
    // Only block on problems in the edited feed (or config-wide ones such as
    // NO_FEEDS), so a pre-existing issue elsewhere cannot lock operators out.
    const relevant = (issue: OracleConfigIssue) => issue.feed === feedId || issue.feed === "(config)";
    const errors = report.errors.filter(relevant);
    if (errors.length > 0) {
      throw new ControlValidationError("Change rejected by oracle config validation", errors);
    }
    return report.warnings.filter(relevant);
  }

  private checkRevision(feedId: string, existing: FeedRecord | undefined, expected?: number): void {
    if (expected === undefined) return;
    const actual = existing?.revision ?? 0;
    if (actual !== expected) {
      throw new ControlConflictError(
        `Feed "${feedId}" is at revision ${actual}, not ${expected}; reload and retry`
      );
    }
  }

  private require(feedId: string): FeedRecord {
    const record = this.feeds.get(feedId);
    if (!record) throw new ControlNotFoundError(`Unknown feed "${feedId}"`);
    return record;
  }

  private view(feedId: string): FeedView {
    const record = this.feeds.get(feedId) as FeedRecord;
    const quarantineOverrides: Record<string, QuarantineOverride> = {};
    for (const [sourceId] of this.quarantine.get(feedId) ?? []) {
      const active = this.quarantineOverride(feedId, sourceId);
      if (active) quarantineOverrides[sourceId] = active;
    }
    return {
      definition: clone(record.definition),
      revision: record.revision,
      updatedBy: record.updatedBy,
      updatedAt: record.updatedAt,
      pause: clone(this.pauses.get(feedId) ?? null),
      quarantineOverrides,
      manualOverride: this.activeManualOverride(feedId),
    };
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private stamp(): { updatedBy: string; updatedAt: string } {
    return { updatedBy: currentActor(), updatedAt: this.timestamp() };
  }

  private stampAt(): Stamp {
    return { by: currentActor(), at: this.timestamp() };
  }
}
