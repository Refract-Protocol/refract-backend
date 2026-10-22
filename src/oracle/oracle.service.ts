import { randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';

/**
 * Methodology registry types.
 *
 * Methodology records describe how a source derives the values it publishes
 * (aggregation method, sampling universe, revision policy, latency profile,
 * known failure modes). Records are immutable: edits create a new version.
 */
export interface MethodologyRecord {
  id: string;
  sourceId: string;
  version: number;
  derivationDescription: string;
  samplingUniverse: string;
  revisionPolicy: string;
  expectedLatencyMs: number;
  knownFailureModes: string[];
  approved: boolean;
  approvedBy: string | null;
  approvedAt: Date | null;
  signOffIndependence: boolean;
  signOffAccuracy: boolean;
  signOffLegal: boolean;
  reattestationDueAt: Date | null;
  lastReattestedAt: Date | null;
  divergenceFlagged: boolean;
  divergenceNotes: string | null;
  createdAt: Date;
  createdBy: string | null;
}

export interface CreateMethodologyInput {
  sourceId: string;
  derivationDescription: string;
  samplingUniverse: string;
  revisionPolicy: string;
  expectedLatencyMs: number;
  knownFailureModes: string[];
  reattestationIntervalDays?: number;
  createdBy?: string;
}

export interface ApproveMethodologyInput {
  methodologyId: string;
  approvedBy: string;
  signOffIndependence: boolean;
  signOffAccuracy: boolean;
  signOffLegal: boolean;
}

export interface ObservedBehavior {
  /** Observed aggregation method, if detectable. */
  aggregationMethod?: string;
  /** Observed sampling universe, if detectable. */
  samplingUniverse?: string;
  /** Observed latency in ms. */
  latencyMs?: number;
  /** Free-form notes. */
  notes?: string;
}

export interface MethodologyDivergence {
  sourceId: string;
  methodologyId: string;
  methodologyVersion: number;
  reasons: string[];
  observed: ObservedBehavior;
  flaggedAt: Date;
}

export interface FeedMethodologyView {
  feedId: string;
  sources: Array<{
    sourceId: string;
    methodologyId: string;
    version: number;
    derivationDescription: string;
    samplingUniverse: string;
    revisionPolicy: string;
    expectedLatencyMs: number;
    knownFailureModes: string[];
    approved: boolean;
    approvedAt: Date | null;
    divergenceFlagged: boolean;
    reattestationDueAt: Date | null;
  }>;
}

export class MethodologyError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'MethodologyError';
  }
}

export interface OracleServiceDeps {
  pool: Pool;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

const DEFAULT_REATTESTATION_INTERVAL_DAYS = 90;

export class OracleService {
  private readonly pool: Pool;
  private readonly logger: NonNullable<OracleServiceDeps['logger']>;

  constructor(deps: OracleServiceDeps) {
    this.pool = deps.pool;
    this.logger =
      deps.logger ??
      ({
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      } as NonNullable<OracleServiceDeps['logger']>);
  }

  // ---------------------------------------------------------------------------
  // Methodology registry
  // ---------------------------------------------------------------------------

  /**
   * Create a new immutable methodology version for a source.
   * The version number is derived from the current max version for the source.
   */
  async createMethodologyVersion(
    input: CreateMethodologyInput,
    client?: PoolClient,
  ): Promise<MethodologyRecord> {
    if (!input.sourceId) {
      throw new MethodologyError('sourceId is required', 'MISSING_SOURCE_ID');
    }
    if (!input.derivationDescription || input.derivationDescription.trim().length === 0) {
      throw new MethodologyError(
        'derivationDescription is required',
        'MISSING_DERIVATION',
      );
    }
    if (!input.samplingUniverse || input.samplingUniverse.trim().length === 0) {
      throw new MethodologyError(
        'samplingUniverse is required',
        'MISSING_SAMPLING_UNIVERSE',
      );
    }
    if (!input.revisionPolicy || input.revisionPolicy.trim().length === 0) {
      throw new MethodologyError(
        'revisionPolicy is required',
        'MISSING_REVISION_POLICY',
      );
    }
    if (
      typeof input.expectedLatencyMs !== 'number' ||
      !Number.isFinite(input.expectedLatencyMs) ||
      input.expectedLatencyMs < 0
    ) {
      throw new MethodologyError(
        'expectedLatencyMs must be a non-negative number',
        'INVALID_LATENCY',
      );
    }
    if (!Array.isArray(input.knownFailureModes) || input.knownFailureModes.length === 0) {
      throw new MethodologyError(
        'knownFailureModes must be a non-empty array',
        'MISSING_FAILURE_MODES',
      );
    }

    const runner = client ?? this.pool;
    const id = randomUUID();
    const intervalDays =
      input.reattestationIntervalDays ?? DEFAULT_REATTESTATION_INTERVAL_DAYS;

    const { rows } = await runner.query(
      `WITH next_version AS (
         SELECT COALESCE(MAX(version), 0) + 1 AS v
         FROM oracle_methodology
         WHERE source_id = $1
       )
       INSERT INTO oracle_methodology (
         id, source_id, version, derivation_description, sampling_universe,
         revision_policy, expected_latency_ms, known_failure_modes,
         approved, reattestation_due_at, created_by
       )
       SELECT $2, $1, next_version.v, $3, $4, $5, $6, $7, false,
              now() + ($8::int * INTERVAL '1 day'), $9
       FROM next_version
       RETURNING *`,
      [
        input.sourceId,
        id,
        input.derivationDescription,
        input.samplingUniverse,
        input.revisionPolicy,
        input.expectedLatencyMs,
        input.knownFailureModes,
        intervalDays,
        input.createdBy ?? null,
      ],
    );

    const record = this.mapMethodologyRow(rows[0]);
    this.logger.info('methodology version created', {
      sourceId: record.sourceId,
      methodologyId: record.id,
      version: record.version,
    });
    return record;
  }

  /**
   * Approve a methodology version with explicit sign-off flags.
   * Approval is a one-way transition; approved rows are never mutated again.
   */
  async approveMethodologyVersion(
    input: ApproveMethodologyInput,
  ): Promise<MethodologyRecord> {
    if (!input.approvedBy) {
      throw new MethodologyError('approvedBy is required', 'MISSING_APPROVER');
    }
    if (!input.signOffIndependence || !input.signOffAccuracy || !input.signOffLegal) {
      throw new MethodologyError(
        'all sign-off flags (independence, accuracy, legal) must be true to approve',
        'INCOMPLETE_SIGN_OFF',
      );
    }

    const { rows } = await this.pool.query(
      `UPDATE oracle_methodology
         SET approved = true,
             approved_by = $2,
             approved_at = now(),
             sign_off_independence = $3,
             sign_off_accuracy = $4,
             sign_off_legal = $5
       WHERE id = $1 AND approved = false
       RETURNING *`,
      [
        input.methodologyId,
        input.approvedBy,
        input.signOffIndependence,
        input.signOffAccuracy,
        input.signOffLegal,
      ],
    );

    if (rows.length === 0) {
      throw new MethodologyError(
        'methodology not found or already approved',
        'NOT_APPROVABLE',
      );
    }

    const record = this.mapMethodologyRow(rows[0]);
    this.logger.info('methodology version approved', {
      sourceId: record.sourceId,
      methodologyId: record.id,
      version: record.version,
      approvedBy: record.approvedBy,
    });
    return record;
  }

  /**
   * Return the currently active (latest approved) methodology for a source.
   */
  async getActiveMethodology(
    sourceId: string,
    client?: PoolClient,
  ): Promise<MethodologyRecord | null> {
    const runner = client ?? this.pool;
    const { rows } = await runner.query(
      `SELECT * FROM oracle_methodology
        WHERE source_id = $1 AND approved = true
        ORDER BY version DESC
        LIMIT 1`,
      [sourceId],
    );
    return rows.length > 0 ? this.mapMethodologyRow(rows[0]) : null;
  }

  /**
   * Return a specific methodology version (used for point-in-time reconstruction).
   */
  async getMethodologyVersion(
    methodologyId: string,
    client?: PoolClient,
  ): Promise<MethodologyRecord | null> {
    const runner = client ?? this.pool;
    const { rows } = await runner.query(
      `SELECT * FROM oracle_methodology WHERE id = $1`,
      [methodologyId],
    );
    return rows.length > 0 ? this.mapMethodologyRow(rows[0]) : null;
  }

  /**
   * Assert that a source may be activated. Throws when no approved methodology
   * exists, or when the active methodology has been flagged for divergence.
   */
  async assertSourceActivatable(
    sourceId: string,
    client?: PoolClient,
  ): Promise<MethodologyRecord> {
    const active = await this.getActiveMethodology(sourceId, client);
    if (!active) {
      throw new MethodologyError(
        `source ${sourceId} cannot be activated: no approved methodology record`,
        'NO_APPROVED_METHODOLOGY',
      );
    }
    if (active.divergenceFlagged) {
      throw new MethodologyError(
        `source ${sourceId} cannot be activated: methodology divergence flagged`,
        'METHODOLOGY_DIVERGENCE',
      );
    }
    return active;
  }

  /**
   * Re-attestation check: compare observed behavior against the recorded
   * methodology and flag the source when they diverge.
   */
  async checkReattestation(
    sourceId: string,
    observed: ObservedBehavior,
  ): Promise<MethodologyDivergence | null> {
    const active = await this.getActiveMethodology(sourceId);
    if (!active) {
      throw new MethodologyError(
        `source ${sourceId} has no approved methodology to re-attest`,
        'NO_APPROVED_METHODOLOGY',
      );
    }

    const reasons: string[] = [];

    if (
      observed.aggregationMethod &&
      !this.descriptionMentions(
        active.derivationDescription,
        observed.aggregationMethod,
      )
    ) {
      reasons.push(
        `observed aggregation method "${observed.aggregationMethod}" not described in methodology`,
      );
    }

    if (
      observed.samplingUniverse &&
      !this.descriptionMentions(active.samplingUniverse, observed.samplingUniverse)
    ) {
      reasons.push(
        `observed sampling universe "${observed.samplingUniverse}" not described in methodology`,
      );
    }

    if (
      typeof observed.latencyMs === 'number' &&
      observed.latencyMs > active.expectedLatencyMs * 2
    ) {
      reasons.push(
        `observed latency ${observed.latencyMs}ms exceeds 2x expected ${active.expectedLatencyMs}ms`,
      );
    }

    if (reasons.length === 0) {
      // Record successful re-attestation.
      await this.pool.query(
        `UPDATE oracle_methodology
            SET last_reattested_at = now(),
                reattestation_due_at = now() + INTERVAL '90 days'
          WHERE id = $1`,
        [active.id],
      );
      return null;
    }

    const flaggedAt = new Date();
    await this.pool.query(
      `UPDATE oracle_methodology
          SET divergence_flagged = true,
              divergence_notes = $2,
              last_reattested_at = now()
        WHERE id = $1`,
      [active.id, reasons.join('; ')],
    );

    this.logger.warn('methodology divergence flagged', {
      sourceId,
      methodologyId: active.id,
      version: active.version,
      reasons,
    });

    return {
      sourceId,
      methodologyId: active.id,
      methodologyVersion: active.version,
      reasons,
      observed,
      flaggedAt,
    };
  }

  /**
   * Resolve the methodology versions used by a feed's sources, for the
   * public trust/provenance surface.
   */
  async getMethodologyForFeed(feedId: string): Promise<FeedMethodologyView> {
    const { rows } = await this.pool.query(
      `SELECT s.source_id, m.*
         FROM oracle_feed_sources s
         JOIN LATERAL (
           SELECT * FROM oracle_methodology
            WHERE source_id = s.source_id AND approved = true
            ORDER BY version DESC
            LIMIT 1
         ) m ON true
        WHERE s.feed_id = $1
        ORDER BY s.source_id`,
      [feedId],
    );

    return {
      feedId,
      sources: rows.map((row) => {
        const m = this.mapMethodologyRow(row);
        return {
          sourceId: m.sourceId,
          methodologyId: m.id,
          version: m.version,
          derivationDescription: m.derivationDescription,
          samplingUniverse: m.samplingUniverse,
          revisionPolicy: m.revisionPolicy,
          expectedLatencyMs: m.expectedLatencyMs,
          knownFailureModes: m.knownFailureModes,
          approved: m.approved,
          approvedAt: m.approvedAt,
          divergenceFlagged: m.divergenceFlagged,
          reattestationDueAt: m.reattestationDueAt,
        };
      }),
    };
  }

  /**
   * Resolve the methodology version ids used for a set of sources at a point
   * in time. Used when writing consensus decisions and evidence records.
   */
  async resolveMethodologyVersions(
    sourceIds: string[],
    client?: PoolClient,
  ): Promise<Record<string, string>> {
    const runner = client ?? this.pool;
    const result: Record<string, string> = {};
    for (const sourceId of sourceIds) {
      const active = await this.getActiveMethodology(sourceId, client);
      if (!active) {
        throw new MethodologyError(
          `source ${sourceId} has no approved methodology`,
          'NO_APPROVED_METHODOLOGY',
        );
      }
      result[sourceId] = active.id;
    }
    void runner;
    return result;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private descriptionMentions(haystack: string, needle: string): boolean {
    if (!haystack || !needle) return false;
    return haystack.toLowerCase().includes(needle.toLowerCase());
  }

  private mapMethodologyRow(row: any): MethodologyRecord {
    return {
      id: row.id,
      sourceId: row.source_id,
      version: Number(row.version),
      derivationDescription: row.derivation_description,
      samplingUniverse: row.sampling_universe,
      revisionPolicy: row.revision_policy,
      expectedLatencyMs: Number(row.expected_latency_ms),
      knownFailureModes: Array.isArray(row.known_failure_modes)
        ? row.known_failure_modes
        : [],
      approved: Boolean(row.approved),
      approvedBy: row.approved_by ?? null,
      approvedAt: row.approved_at ? new Date(row.approved_at) : null,
      signOffIndependence: Boolean(row.sign_off_independence),
      signOffAccuracy: Boolean(row.sign_off_accuracy),
      signOffLegal: Boolean(row.sign_off_legal),
      reattestationDueAt: row.reattestation_due_at
        ? new Date(row.reattestation_due_at)
        : null,
      lastReattestedAt: row.last_reattested_at
        ? new Date(row.last_reattested_at)
        : null,
      divergenceFlagged: Boolean(row.divergence_flagged),
      divergenceNotes: row.divergence_notes ?? null,
      createdAt: new Date(row.created_at),
      createdBy: row.created_by ?? null,
    };
  }
}