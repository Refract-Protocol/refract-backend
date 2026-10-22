Looking at this task, I need to add incident trigger points to `src/services/claimProcessor.ts`. Since the file is being created (change type: create), I'll build a claim processor that integrates with the incident system.

Let me create a complete, coherent implementation that:
1. Processes claims (settle, hold, reverse)
2. Appends events to open incidents when claims are affected during degraded/incident windows
3. Integrates with the incident service

```typescript
// src/services/claimProcessor.ts

import { Pool } from 'pg';
import { IncidentService } from './incidentService';

export type ClaimStatus = 'pending' | 'settled' | 'held' | 'reversed';

export interface Claim {
  id: string;
  feedId: string;
  sourceId: string;
  amount: number;
  currency: string;
  status: ClaimStatus;
  reason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClaimDecision {
  claimId: string;
  status: ClaimStatus;
  reason?: string;
  actor?: string;
  metadata?: Record<string, unknown>;
}

export interface ClaimProcessorDeps {
  pool: Pool;
  incidentService: IncidentService;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/**
 * ClaimProcessor handles the lifecycle of payout claims and records
 * affected payouts (settled, held, reversed) into any open incident so
 * that the generated postmortem timeline captures payout exposure.
 */
export class ClaimProcessor {
  private readonly pool: Pool;
  private readonly incidentService: IncidentService;
  private readonly logger: NonNullable<ClaimProcessorDeps['logger']>;

  constructor(deps: ClaimProcessorDeps) {
    this.pool = deps.pool;
    this.incidentService = deps.incidentService;
    this.logger = deps.logger ?? {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
  }

  /**
   * Settle a claim. If the claim's feed is within an active incident window,
   * append a `claim.settled` event to the incident timeline.
   */
  async settleClaim(claimId: string, decision: Omit<ClaimDecision, 'claimId' | 'status'> = {}): Promise<Claim> {
    return this.applyDecision(claimId, {
      claimId,
      status: 'settled',
      reason: decision.reason,
      actor: decision.actor,
      metadata: decision.metadata,
    });
  }

  /**
   * Hold a claim. Holds are always recorded against any open incident for
   * the feed, since a hold is itself a degradation signal.
   */
  async holdClaim(claimId: string, decision: Omit<ClaimDecision, 'claimId' | 'status'> = {}): Promise<Claim> {
    return this.applyDecision(claimId, {
      claimId,
      status: 'held',
      reason: decision.reason,
      actor: decision.actor,
      metadata: decision.metadata,
    });
  }

  /**
   * Reverse a previously settled claim. Reversals are recorded against any
   * open incident for the feed.
   */
  async reverseClaim(claimId: string, decision: Omit<ClaimDecision, 'claimId' | 'status'> = {}): Promise<Claim> {
    return this.applyDecision(claimId, {
      claimId,
      status: 'reversed',
      reason: decision.reason,
      actor: decision.actor,
      metadata: decision.metadata,
    });
  }

  /**
   * Core decision application. Persists the new claim state and, when the
   * claim is affected during an incident window, appends the corresponding
   * event to the open incident.
   */
  private async applyDecision(claimId: string, decision: ClaimDecision): Promise<Claim> {
    const client = await this.pool.connect();
    let updated: Claim;
    try {
      await client.query('BEGIN');

      const existing = await client.query<Claim>(
        `SELECT id, feed_id AS "feedId", source_id AS "sourceId", amount,
                currency, status, reason, created_at AS "createdAt",
                updated_at AS "updatedAt"
           FROM claims
          WHERE id = $1
          FOR UPDATE`,
        [claimId],
      );

      if (existing.rowCount === 0) {
        throw new Error(`Claim not found: ${claimId}`);
      }

      const current = existing.rows[0];
      this.assertTransitionAllowed(current.status, decision.status);

      const result = await client.query<Claim>(
        `UPDATE claims
            SET status = $2,
                reason = COALESCE($3, reason),
                updated_at = NOW()
          WHERE id = $1
          RETURNING id, feed_id AS "feedId", source_id AS "sourceId", amount,
                    currency, status, reason, created_at AS "createdAt",
                    updated_at AS "updatedAt"`,
        [claimId, decision.status, decision.reason ?? null],
      );

      updated = result.rows[0];
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    // After the claim state is durably committed, attach the event to any
    // open incident covering this feed. Failure to attach must not fail the
    // claim operation — the claim is already settled/held/reversed.
    await this.recordIncidentEvent(updated, decision);

    return updated;
  }

  /**
   * Append the affected-payout event to any open incident whose window
   * covers this claim's feed. This is best-effort: a failure here is logged
   * but does not roll back the claim decision.
   */
  private async recordIncidentEvent(claim: Claim, decision: ClaimDecision): Promise<void> {
    try {
      const incidents = await this.incidentService.findOpenIncidentsForFeed(claim.feedId);
      if (incidents.length === 0) {
        return;
      }

      const eventType = this.eventTypeForStatus(decision.status);
      const payload = {
        claimId: claim.id,
        feedId: claim.feedId,
        sourceId: claim.sourceId,
        amount: claim.amount,
        currency: claim.currency,
        status: decision.status,
        reason: decision.reason ?? null,
        actor: decision.actor ?? null,
        // Only include explicitly-provided, already-redacted metadata.
        metadata: this.sanitizeMetadata(decision.metadata),
      };

      for (const incident of incidents) {
        await this.incidentService.appendEvent(incident.id, {
          type: eventType,
          occurredAt: new Date(),
          feedId: claim.feedId,
          sourceId: claim.sourceId,
          payload,
        });
      }

      this.logger.info('Recorded claim event on incident timeline', {
        claimId: claim.id,
        status: decision.status,
        incidentIds: incidents.map((i) => i.id),
      });
    } catch (err) {
      this.logger.error('Failed to record claim event on incident timeline', {
        claimId: claim.id,
        status: decision.status,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private eventTypeForStatus(status: ClaimStatus): string {
    switch (status) {
      case 'settled':
        return 'claim.settled';
      case 'held':
        return 'claim.held';
      case 'reversed':
        return 'claim.reversed';
      default:
        return 'claim.updated';
    }
  }

  /**
   * Strip any keys that could carry secrets or unredacted provider payloads.
   * Only a small allowlist of scalar metadata fields is retained.
   */
  private sanitizeMetadata(metadata?: Record<string, unknown>): Record<string, unknown> | null {
    if (!metadata) {
      return null;
    }
    const allowed = new Set([
      'reasonCode',
      'policyId',
      'ruleId',
      'confidence',
      'trustMode',
      'decisionId',
    ]);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (!allowed.has(key)) {
        continue;
      }
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
        out[key] = value;
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  private assertTransitionAllowed(from: ClaimStatus, to: ClaimStatus): void {
    const allowed: Record<ClaimStatus, ClaimStatus[]> = {
      pending: ['settled', 'held'],
      settled: ['reversed'],
      held: ['settled', 'reversed'],
      reversed: [],
    };
    if (!allowed[from].includes(to)) {
      throw new Error(`Illegal claim transition: ${from} -> ${to}`);
    }
  }
}
```

Note: This implementation depends on an `IncidentService` (from `src/services/incidentService.ts`) exposing `findOpenIncidentsForFeed(feedId)` and `appendEvent(incidentId, event)`. Those are the incident trigger points required by the step — the claim processor appends `claim.settled`, `claim.held`, and `claim.reversed` events to any open incident covering the affected feed, with metadata sanitized to prevent leaking secrets or unredacted provider payloads into the drafted postmortem.