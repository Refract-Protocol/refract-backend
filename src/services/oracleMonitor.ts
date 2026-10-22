import { EventEmitter } from 'events';
import { ReferenceDataService, EntityValidationResult } from '../oracle/referenceData';
import { DeadLetterQueue } from '../oracle/deadLetterQueue';

/**
 * Represents a single reading observed from a payout-triggering feed.
 * Readings carry provider-native entity references that must be resolved
 * and validated against the pinned reference dataset before they can
 * become eligible for consensus.
 */
export interface FeedReading {
  id: string;
  feedId: string;
  feedType: string;
  providerId: string;
  /** Provider-native entity references (e.g. airport codes, protocol slugs, asset tickers). */
  entityRefs: EntityReference[];
  payload: Record<string, unknown>;
  observedAt: number;
  /** Optional dataset version pin; falls back to the feed's configured pin. */
  datasetVersion?: string;
}

export interface EntityReference {
  /** The kind of entity being referenced (airport, route, carrier, protocol, market, chain, asset). */
  kind: string;
  /** Provider-native identifier. */
  providerId: string;
  /** Optional disambiguation context (e.g. chain + contract for assets). */
  context?: Record<string, string>;
}

export interface ValidatedReading extends FeedReading {
  /** Canonical entity references resolved from the reference dataset. */
  canonicalRefs: CanonicalEntityRef[];
  datasetVersion: string;
  validatedAt: number;
}

export interface CanonicalEntityRef {
  kind: string;
  canonicalId: string;
  datasetVersion: string;
}

export interface RejectedReading {
  reading: FeedReading;
  reason: string;
  datasetVersion: string;
  rejectedAt: number;
  details?: Record<string, unknown>;
}

export interface OracleMonitorConfig {
  /** Default dataset version pinned for feeds that do not specify one. */
  defaultDatasetVersion: string;
  /** Per-feed dataset version pins. */
  feedDatasetVersions?: Record<string, string>;
  /** Window (ms) over which unknown-entity rejections are aggregated for alerting. */
  stormWindowMs?: number;
  /** Threshold of unknown-entity rejections within the window before an alert fires. */
  stormThreshold?: number;
  /** Minimum interval (ms) between storm alerts to avoid flooding. */
  stormAlertCooldownMs?: number;
}

const DEFAULT_STORM_WINDOW_MS = 60_000;
const DEFAULT_STORM_THRESHOLD = 25;
const DEFAULT_STORM_ALERT_COOLDOWN_MS = 5 * 60_000;

interface StormBucket {
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
  sampleReasons: Set<string>;
  sampleFeedIds: Set<string>;
}

/**
 * OracleMonitor observes readings from payout-triggering feeds, validates
 * their entity references against a pinned reference dataset version, and
 * forwards rejected readings to the dead-letter path. Only validated
 * readings are eligible for consensus.
 */
export class OracleMonitor extends EventEmitter {
  private readonly referenceData: ReferenceDataService;
  private readonly deadLetter: DeadLetterQueue;
  private readonly config: Required<Pick<OracleMonitorConfig, 'defaultDatasetVersion' | 'stormWindowMs' | 'stormThreshold' | 'stormAlertCooldownMs'>> & {
    feedDatasetVersions: Record<string, string>;
  };

  /** Readings that passed validation and are eligible for consensus. */
  private readonly eligibleReadings: Map<string, ValidatedReading> = new Map();
  /** Readings rejected during validation, retained for audit. */
  private readonly rejectedReadings: Map<string, RejectedReading> = new Map();

  /** Aggregation buckets for unknown-entity storms keyed by feedId. */
  private readonly stormBuckets: Map<string, StormBucket> = new Map();
  /** Last time a storm alert was emitted, keyed by feedId. */
  private readonly lastStormAlertAt: Map<string, number> = new Map();

  constructor(
    referenceData: ReferenceDataService,
    deadLetter: DeadLetterQueue,
    config: OracleMonitorConfig,
  ) {
    super();
    if (!config || !config.defaultDatasetVersion) {
      throw new Error('OracleMonitor requires a defaultDatasetVersion');
    }
    this.referenceData = referenceData;
    this.deadLetter = deadLetter;
    this.config = {
      defaultDatasetVersion: config.defaultDatasetVersion,
      feedDatasetVersions: config.feedDatasetVersions ?? {},
      stormWindowMs: config.stormWindowMs ?? DEFAULT_STORM_WINDOW_MS,
      stormThreshold: config.stormThreshold ?? DEFAULT_STORM_THRESHOLD,
      stormAlertCooldownMs: config.stormAlertCooldownMs ?? DEFAULT_STORM_ALERT_COOLDOWN_MS,
    };
  }

  /**
   * Resolve the dataset version pinned for a given feed. Feed-level pins take
   * precedence over the monitor default so a dataset refresh cannot
   * retroactively change how a past reading was interpreted.
   */
  public getPinnedDatasetVersion(feedId: string): string {
    return this.config.feedDatasetVersions[feedId] ?? this.config.defaultDatasetVersion;
  }

  /**
   * Observe a reading. Validates entity references against the pinned dataset
   * version. Valid readings become eligible for consensus; rejected readings
   * are forwarded to the dead-letter path and never counted toward quorum.
   */
  public async observeReading(reading: FeedReading): Promise<EntityValidationResult> {
    const datasetVersion = reading.datasetVersion ?? this.getPinnedDatasetVersion(reading.feedId);

    let result: EntityValidationResult;
    try {
      result = await this.referenceData.validateReading(
        {
          feedId: reading.feedId,
          feedType: reading.feedType,
          providerId: reading.providerId,
          entityRefs: reading.entityRefs,
        },
        datasetVersion,
      );
    } catch (err) {
      const reason = `reference-data validation error: ${(err as Error).message}`;
      this.rejectReading(reading, reason, datasetVersion, { error: (err as Error).message });
      return { valid: false, reason, datasetVersion, canonicalRefs: [] };
    }

    if (!result.valid) {
      this.rejectReading(reading, result.reason ?? 'unknown entity', datasetVersion, result.details);
      return result;
    }

    const validated: ValidatedReading = {
      ...reading,
      canonicalRefs: result.canonicalRefs ?? [],
      datasetVersion,
      validatedAt: Date.now(),
    };
    this.eligibleReadings.set(reading.id, validated);
    this.emit('reading:validated', validated);
    return result;
  }

  /**
   * Observe a batch of readings. Returns the validated readings; rejected
   * readings are routed to the dead-letter path and excluded from the result.
   */
  public async observeReadings(readings: FeedReading[]): Promise<ValidatedReading[]> {
    const validated: ValidatedReading[] = [];
    for (const reading of readings) {
      const result = await this.observeReading(reading);
      if (result.valid) {
        const stored = this.eligibleReadings.get(reading.id);
        if (stored) {
          validated.push(stored);
        }
      }
    }
    return validated;
  }

  /**
   * Return readings currently eligible for consensus. Rejected readings are
   * never included.
   */
  public getEligibleReadings(): ValidatedReading[] {
    return Array.from(this.eligibleReadings.values());
  }

  /**
   * Return rejected readings retained for audit.
   */
  public getRejectedReadings(): RejectedReading[] {
    return Array.from(this.rejectedReadings.values());
  }

  /**
   * Clear eligible readings after a consensus round has consumed them.
   */
  public clearEligibleReadings(): void {
    this.eligibleReadings.clear();
  }

  private rejectReading(
    reading: FeedReading,
    reason: string,
    datasetVersion: string,
    details?: Record<string, unknown>,
  ): void {
    const rejected: RejectedReading = {
      reading,
      reason,
      datasetVersion,
      rejectedAt: Date.now(),
      details,
    };
    this.rejectedReadings.set(reading.id, rejected);

    // Forward to the dead-letter path so the reading is never counted toward quorum.
    try {
      this.deadLetter.enqueue({
        id: reading.id,
        feedId: reading.feedId,
        feedType: reading.feedType,
        providerId: reading.providerId,
        reason,
        datasetVersion,
        payload: reading.payload,
        entityRefs: reading.entityRefs,
        rejectedAt: rejected.rejectedAt,
        details,
      });
    } catch (err) {
      this.emit('deadletter:error', { readingId: reading.id, error: (err as Error).message });
    }

    this.emit('reading:rejected', rejected);

    if (this.isUnknownEntityReason(reason)) {
      this.recordUnknownEntity(reading, reason);
    }
  }

  private isUnknownEntityReason(reason: string): boolean {
    const normalized = reason.toLowerCase();
    return (
      normalized.includes('unknown') ||
      normalized.includes('unresolved') ||
      normalized.includes('not found') ||
      normalized.includes('retired') ||
      normalized.includes('ambiguous')
    );
  }

  /**
   * Aggregate unknown-entity rejections per feed and emit a rate-limited
   * alert when a storm is detected. This prevents alert flooding during
   * provider outages while still surfacing sustained unknown-entity issues.
   */
  private recordUnknownEntity(reading: FeedReading, reason: string): void {
    const now = Date.now();
    const feedId = reading.feedId;
    let bucket = this.stormBuckets.get(feedId);

    if (!bucket || now - bucket.firstSeenAt > this.config.stormWindowMs) {
      bucket = {
        count: 0,
        firstSeenAt: now,
        lastSeenAt: now,
        sampleReasons: new Set(),
        sampleFeedIds: new Set(),
      };
      this.stormBuckets.set(feedId, bucket);
    }

    bucket.count += 1;
    bucket.lastSeenAt = now;
    if (bucket.sampleReasons.size < 5) {
      bucket.sampleReasons.add(reason);
    }
    bucket.sampleFeedIds.add(feedId);

    if (bucket.count < this.config.stormThreshold) {
      return;
    }

    const lastAlert = this.lastStormAlertAt.get(feedId) ?? 0;
    if (now - lastAlert < this.config.stormAlertCooldownMs) {
      return;
    }

    this.lastStormAlertAt.set(feedId, now);
    const alert = {
      feedId,
      count: bucket.count,
      windowMs: this.config.stormWindowMs,
      firstSeenAt: bucket.firstSeenAt,
      lastSeenAt: bucket.lastSeenAt,
      sampleReasons: Array.from(bucket.sampleReasons),
      datasetVersion: reading.datasetVersion ?? this.getPinnedDatasetVersion(feedId),
    };

    // Reset the bucket after alerting so the next window starts fresh.
    this.stormBuckets.delete(feedId);

    this.emit('alert:unknown-entity-storm', alert);
  }
}

export default OracleMonitor;