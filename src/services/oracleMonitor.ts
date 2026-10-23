import { EventEmitter } from 'events';
import { Pool } from 'pg';
import { IncidentService, IncidentTriggerClass } from './incidentService';

/**
 * Oracle Monitor Service
 *
 * Watches oracle feeds for health, consensus, and freshness problems and
 * opens incidents in the evidence ledger when defined trigger classes fire.
 *
 * Trigger classes that auto-open (or group into) an incident:
 *   - circuit_breaker_trip
 *   - quorum_failure
 *   - freshness_breach
 *   - operator_pause
 *   - backfill_replay
 *
 * Rolling breaker trips within the grouping window are attached to the
 * existing open incident rather than creating duplicates.
 */

export type FeedHealth = 'healthy' | 'degraded' | 'unhealthy' | 'paused' | 'unknown';

export interface SourceReading {
  sourceId: string;
  feedId: string;
  value: number | null;
  health: FeedHealth;
  observedAt: Date;
  /** Raw provider payload; must never be rendered unredacted. */
  providerPayload?: Record<string, unknown>;
}

export interface ConsensusOutcome {
  feedId: string;
  decisionId: string;
  agreed: boolean;
  reason: string;
  value: number | null;
  quorumReached: boolean;
  participatingSources: string[];
  decidedAt: Date;
}

export interface CircuitBreakerState {
  feedId: string;
  open: boolean;
  reason: string;
  trippedAt: Date;
}

export interface FreshnessState {
  feedId: string;
  lastUpdatedAt: Date;
  maxAgeMs: number;
  breached: boolean;
}

export interface OperatorPauseEvent {
  feedId: string;
  operatorId: string;
  reason: string;
  pausedAt: Date;
}

export interface BackfillReplayEvent {
  feedId: string;
  replayId: string;
  fromAt: Date;
  toAt: Date;
  initiatedBy: string;
  startedAt: Date;
}

export interface OracleMonitorConfig {
  /** Rolling window (ms) within which repeated breaker trips group together. */
  breakerGroupingWindowMs: number;
  /** Max age (ms) before a feed is considered stale. */
  freshnessMaxAgeMs: number;
}

const DEFAULT_CONFIG: OracleMonitorConfig = {
  breakerGroupingWindowMs: 15 * 60 * 1000,
  freshnessMaxAgeMs: 5 * 60 * 1000,
};

export interface OracleMonitorDeps {
  db: Pool;
  incidentService: IncidentService;
  config?: Partial<OracleMonitorConfig>;
  now?: () => Date;
}

export class OracleMonitor extends EventEmitter {
  private readonly db: Pool;
  private readonly incidentService: IncidentService;
  private readonly config: OracleMonitorConfig;
  private readonly now: () => Date;

  /** Tracks last breaker trip per feed to support grouping. */
  private readonly lastBreakerTrip = new Map<string, Date>();

  constructor(deps: OracleMonitorDeps) {
    super();
    this.db = deps.db;
    this.incidentService = deps.incidentService;
    this.config = { ...DEFAULT_CONFIG, ...(deps.config ?? {}) };
    this.now = deps.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------------------
  // Trigger points
  // ---------------------------------------------------------------------------

  /**
   * Called when a circuit breaker trips for a feed. Repeated trips within the
   * grouping window attach to the existing incident instead of opening a new
   * one.
   */
  async onCircuitBreakerTrip(state: CircuitBreakerState): Promise<void> {
    if (!state.open) {
      return;
    }

    const trippedAt = state.trippedAt ?? this.now();
    const lastTrip = this.lastBreakerTrip.get(state.feedId);
    const withinWindow =
      lastTrip !== undefined &&
      trippedAt.getTime() - lastTrip.getTime() <= this.config.breakerGroupingWindowMs;

    this.lastBreakerTrip.set(state.feedId, trippedAt);

    const ledgerEventId = await this.recordLedgerEvent({
      feedId: state.feedId,
      eventType: 'circuit_breaker_trip',
      occurredAt: trippedAt,
      payload: {
        reason: state.reason,
        grouped: withinWindow,
      },
    });

    await this.incidentService.openOrGroupIncident({
      triggerClass: 'circuit_breaker_trip',
      feedId: state.feedId,
      occurredAt: trippedAt,
      ledgerEventId,
      groupingKey: `circuit_breaker_trip:${state.feedId}`,
      groupingWindowMs: this.config.breakerGroupingWindowMs,
      summary: `Circuit breaker tripped for feed ${state.feedId}: ${state.reason}`,
    });

    this.emit('circuit_breaker_trip', state);
  }

  /**
   * Called when a consensus decision fails to reach quorum or is otherwise
   * rejected.
   */
  async onQuorumFailure(outcome: ConsensusOutcome): Promise<void> {
    if (outcome.quorumReached && outcome.agreed) {
      return;
    }

    const occurredAt = outcome.decidedAt ?? this.now();

    const ledgerEventId = await this.recordLedgerEvent({
      feedId: outcome.feedId,
      eventType: 'quorum_failure',
      occurredAt,
      payload: {
        decisionId: outcome.decisionId,
        reason: outcome.reason,
        quorumReached: outcome.quorumReached,
        participatingSources: outcome.participatingSources,
      },
    });

    await this.incidentService.openOrGroupIncident({
      triggerClass: 'quorum_failure',
      feedId: outcome.feedId,
      occurredAt,
      ledgerEventId,
      groupingKey: `quorum_failure:${outcome.feedId}`,
      groupingWindowMs: this.config.breakerGroupingWindowMs,
      summary: `Quorum failure for feed ${outcome.feedId}: ${outcome.reason}`,
    });

    this.emit('quorum_failure', outcome);
  }

  /**
   * Called when a feed's last update exceeds the freshness threshold.
   */
  async onFreshnessBreach(state: FreshnessState): Promise<void> {
    if (!state.breached) {
      return;
    }

    const occurredAt = this.now();
    const ageMs = occurredAt.getTime() - state.lastUpdatedAt.getTime();

    const ledgerEventId = await this.recordLedgerEvent({
      feedId: state.feedId,
      eventType: 'freshness_breach',
      occurredAt,
      payload: {
        lastUpdatedAt: state.lastUpdatedAt.toISOString(),
        ageMs,
        maxAgeMs: state.maxAgeMs,
      },
    });

    await this.incidentService.openOrGroupIncident({
      triggerClass: 'freshness_breach',
      feedId: state.feedId,
      occurredAt,
      ledgerEventId,
      groupingKey: `freshness_breach:${state.feedId}`,
      groupingWindowMs: this.config.breakerGroupingWindowMs,
      summary: `Freshness breach for feed ${state.feedId}: age ${ageMs}ms exceeds ${state.maxAgeMs}ms`,
    });

    this.emit('freshness_breach', state);
  }

  /**
   * Called when an operator manually pauses a feed.
   */
  async onOperatorPause(event: OperatorPauseEvent): Promise<void> {
    const occurredAt = event.pausedAt ?? this.now();

    const ledgerEventId = await this.recordLedgerEvent({
      feedId: event.feedId,
      eventType: 'operator_pause',
      occurredAt,
      payload: {
        operatorId: event.operatorId,
        reason: event.reason,
      },
    });

    await this.incidentService.openOrGroupIncident({
      triggerClass: 'operator_pause',
      feedId: event.feedId,
      occurredAt,
      ledgerEventId,
      groupingKey: `operator_pause:${event.feedId}`,
      groupingWindowMs: this.config.breakerGroupingWindowMs,
      summary: `Operator ${event.operatorId} paused feed ${event.feedId}: ${event.reason}`,
    });

    this.emit('operator_pause', event);
  }

  /**
   * Called when a backfill or replay operation is initiated.
   */
  async onBackfillReplay(event: BackfillReplayEvent): Promise<void> {
    const occurredAt = event.startedAt ?? this.now();

    const ledgerEventId = await this.recordLedgerEvent({
      feedId: event.feedId,
      eventType: 'backfill_replay',
      occurredAt,
      payload: {
        replayId: event.replayId,
        fromAt: event.fromAt.toISOString(),
        toAt: event.toAt.toISOString(),
        initiatedBy: event.initiatedBy,
      },
    });

    await this.incidentService.openOrGroupIncident({
      triggerClass: 'backfill_replay',
      feedId: event.feedId,
      occurredAt,
      ledgerEventId,
      groupingKey: `backfill_replay:${event.feedId}`,
      groupingWindowMs: this.config.breakerGroupingWindowMs,
      summary: `Backfill/replay ${event.replayId} initiated for feed ${event.feedId} by ${event.initiatedBy}`,
    });

    this.emit('backfill_replay', event);
  }

  // ---------------------------------------------------------------------------
  // Ledger helpers
  // ---------------------------------------------------------------------------

  /**
   * Appends a triggering event to the evidence ledger and returns its id.
   * The payload is stored as-is; redaction happens at render time.
   */
  private async recordLedgerEvent(input: {
    feedId: string;
    eventType: IncidentTriggerClass;
    occurredAt: Date;
    payload: Record<string, unknown>;
  }): Promise<string> {
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO oracle_evidence_ledger (feed_id, event_type, occurred_at, payload)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [input.feedId, input.eventType, input.occurredAt, JSON.stringify(input.payload)],
    );
    return result.rows[0].id;
  }
}

export default OracleMonitor;