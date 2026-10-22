import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import { db } from '../db/client';

/**
 * Classification of a provider payload against its declared response shape.
 * - `ok`: payload matches the declared shape.
 * - `drift`: structurally unexpected but non-fatal (e.g. optional field added).
 * - `breaking`: required structure/unit/nullability violated; ingestion must be rejected.
 */
export type SchemaDriftClassification = 'ok' | 'drift' | 'breaking';

export interface SchemaDriftResult {
  source: string;
  classification: SchemaDriftClassification;
  /** Human-readable reasons for a non-ok classification. */
  reasons: string[];
  /** Redacted, size-limited sample of the offending payload. */
  sample?: unknown;
  /** Last known-good payload sample for this source, if any. */
  lastKnownGoodSample?: unknown;
  detectedAt: string;
}

export interface SourceDriftReport {
  source: string;
  quarantined: boolean;
  lastClassification: SchemaDriftClassification;
  lastDetectedAt: string | null;
  lastKnownGoodSample: unknown | null;
  recentEvents: SchemaDriftResult[];
}

const MAX_SAMPLE_BYTES = 4096;
const MAX_RECENT_EVENTS = 25;

/**
 * Redact and truncate a payload sample so it can be safely stored/queried.
 * Keeps structure for debugging while bounding size and stripping obvious secrets.
 */
export function redactSample(payload: unknown): unknown {
  const seen = new WeakSet<object>();
  const redact = (value: unknown, depth: number): unknown => {
    if (depth > 6) return '[truncated:depth]';
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value as object)) return '[circular]';
    seen.add(value as object);
    if (Array.isArray(value)) {
      return value.slice(0, 20).map((item) => redact(item, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (/key|token|secret|auth|password/i.test(key)) {
        out[key] = '[redacted]';
      } else {
        out[key] = redact(val, depth + 1);
      }
    }
    return out;
  };

  const redacted = redact(payload, 0);
  try {
    const serialized = JSON.stringify(redacted);
    if (serialized && serialized.length > MAX_SAMPLE_BYTES) {
      return { truncated: true, preview: serialized.slice(0, MAX_SAMPLE_BYTES) };
    }
  } catch {
    return '[unserializable]';
  }
  return redacted;
}

interface SourceState {
  quarantined: boolean;
  lastClassification: SchemaDriftClassification;
  lastDetectedAt: string | null;
  lastKnownGoodSample: unknown | null;
  recentEvents: SchemaDriftResult[];
}

export class OracleMonitor extends EventEmitter {
  private readonly sources = new Map<string, SourceState>();

  private stateFor(source: string): SourceState {
    let state = this.sources.get(source);
    if (!state) {
      state = {
        quarantined: false,
        lastClassification: 'ok',
        lastDetectedAt: null,
        lastKnownGoodSample: null,
        recentEvents: [],
      };
      this.sources.set(source, state);
    }
    return state;
  }

  /**
   * Record the outcome of validating a provider payload against its declared shape.
   * Breaking changes quarantine the source and fire an alert; drift only warns.
   * Returns the classification so callers can reject ingestion before parsing.
   */
  recordSchemaValidation(
    source: string,
    classification: SchemaDriftClassification,
    reasons: string[] = [],
    payload?: unknown,
  ): SchemaDriftResult {
    const state = this.stateFor(source);
    const detectedAt = new Date().toISOString();

    const result: SchemaDriftResult = {
      source,
      classification,
      reasons,
      detectedAt,
      lastKnownGoodSample: state.lastKnownGoodSample ?? undefined,
    };

    if (classification === 'ok') {
      state.lastKnownGoodSample = redactSample(payload);
      state.lastClassification = 'ok';
      state.lastDetectedAt = detectedAt;
      return result;
    }

    result.sample = redactSample(payload);
    state.lastClassification = classification;
    state.lastDetectedAt = detectedAt;
    state.recentEvents.unshift(result);
    if (state.recentEvents.length > MAX_RECENT_EVENTS) {
      state.recentEvents.length = MAX_RECENT_EVENTS;
    }

    if (classification === 'breaking') {
      state.quarantined = true;
      logger.error(
        `[oracleMonitor] Breaking schema change for source ${source}; source quarantined`,
        { reasons },
      );
      this.emit('breaking', result);
      this.persistDriftEvent(result).catch((err) =>
        logger.error('[oracleMonitor] Failed to persist drift event', err),
      );
    } else {
      logger.warn(`[oracleMonitor] Schema drift detected for source ${source}`, { reasons });
      this.emit('drift', result);
      this.persistDriftEvent(result).catch((err) =>
        logger.error('[oracleMonitor] Failed to persist drift event', err),
      );
    }

    return result;
  }

  /** Whether a source is currently quarantined due to a breaking schema change. */
  isQuarantined(source: string): boolean {
    return this.stateFor(source).quarantined;
  }

  /** Clear quarantine for a source (e.g. after an operator confirms the shape was updated). */
  clearQuarantine(source: string): void {
    const state = this.stateFor(source);
    state.quarantined = false;
    logger.info(`[oracleMonitor] Quarantine cleared for source ${source}`);
  }

  /** Per-source drift report including the last known-good payload sample. */
  getDriftReport(source: string): SourceDriftReport {
    const state = this.stateFor(source);
    return {
      source,
      quarantined: state.quarantined,
      lastClassification: state.lastClassification,
      lastDetectedAt: state.lastDetectedAt,
      lastKnownGoodSample: state.lastKnownGoodSample,
      recentEvents: [...state.recentEvents],
    };
  }

  /** Drift reports for all sources seen so far. */
  getAllDriftReports(): SourceDriftReport[] {
    return Array.from(this.sources.keys()).map((source) => this.getDriftReport(source));
  }

  private async persistDriftEvent(result: SchemaDriftResult): Promise<void> {
    await db.query(
      `INSERT INTO oracle_schema_drift_events
         (source, classification, reasons, sample, detected_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        result.source,
        result.classification,
        JSON.stringify(result.reasons),
        result.sample === undefined ? null : JSON.stringify(result.sample),
        result.detectedAt,
      ],
    );
  }
}

export const oracleMonitor = new OracleMonitor();
