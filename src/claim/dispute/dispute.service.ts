import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  Optional,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { DatabaseService } from "../../db/database.service";
import { MetricsService } from "../../metrics/metrics.service";
import { TrustEventsService } from "../../oracle/trust-events.service";
import type { TrustEventInput } from "../../oracle/trust-events";

export const DISPUTE_STATUSES = ["open", "under_review", "upheld", "reversed", "withdrawn"] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

type BondStatus = "posted" | "forfeited" | "returned";

/** Allowed moves. Upheld, reversed and withdrawn are final. */
const TRANSITIONS: Record<DisputeStatus, readonly DisputeStatus[]> = {
  open: ["under_review", "withdrawn"],
  under_review: ["upheld", "reversed", "withdrawn"],
  upheld: [],
  reversed: [],
  withdrawn: [],
};

const BOND_ON_RESOLUTION: Partial<Record<DisputeStatus, Exclude<BondStatus, "posted">>> = {
  upheld: "forfeited",
  reversed: "returned",
  withdrawn: "returned",
};

const DEFAULT_WINDOW_HOURS = 72;
const UNIQUE_VIOLATION = "23505";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DisputeRecord {
  id: string;
  decisionId: string;
  policyId: string;
  coverageType: string;
  status: DisputeStatus;
  reason: string;
  bondReference: string;
  bondStatus: BondStatus;
  openedBy: string;
  windowClosesAt: Date;
  resolutionNote: string | null;
  replacementDecisionId: string | null;
  reversal: { amount: string; status: string } | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

interface DisputeRow {
  id: string;
  decisionId: string;
  policyId: string;
  coverageType: string;
  status: DisputeStatus;
  reason: string;
  bondReference: string;
  bondStatus: BondStatus;
  openedBy: string;
  windowClosesAt: Date;
  resolutionNote: string | null;
  replacementDecisionId: string | null;
  reversalAmount: string | null;
  reversalStatus: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface OpenDisputeInput {
  decisionId: string;
  reason: string;
  bondReference: string;
  actor: string;
}

export interface TransitionDisputeInput {
  to: Exclude<DisputeStatus, "open">;
  note?: string;
  replacementDecisionId?: string;
  actor: string;
}

const SELECT_DISPUTE = `
  SELECT d.id, d.decision_id AS "decisionId", d.policy_id AS "policyId",
         p.coverage_type::text AS "coverageType", d.status, d.reason,
         d.bond_reference AS "bondReference", d.bond_status AS "bondStatus",
         d.opened_by AS "openedBy", d.window_closes_at AS "windowClosesAt",
         d.resolution_note AS "resolutionNote",
         d.replacement_decision_id AS "replacementDecisionId",
         r.amount::text AS "reversalAmount", r.status AS "reversalStatus",
         d.created_at AS "createdAt", d.resolved_at AS "resolvedAt"
    FROM claim_disputes d
    JOIN policies p ON p.id = d.policy_id
    LEFT JOIN settlement_reversals r ON r.dispute_id = d.id`;

/** Window per coverage type, in hours. Env: JSON object, e.g. {"default":72,"stablecoin_depeg":24}. */
export function parseDisputeWindows(raw: string | undefined): Record<string, number> {
  if (!raw?.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("DISPUTE_WINDOW_HOURS must be a JSON object of positive hour values");
  }
  const windows: Record<string, number> = {};
  for (const [coverage, hours] of Object.entries(parsed)) {
    if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0) {
      throw new Error(`DISPUTE_WINDOW_HOURS.${coverage} must be a positive number of hours`);
    }
    windows[coverage] = hours;
  }
  return windows;
}

/**
 * Bonded challenge workflow for payout-triggering decisions.
 *
 * Timing is judged by the database clock (`now()` and the settlement's
 * `created_at`), never by the caller's clock. A decision is final once its
 * window has elapsed or a dispute on it has resolved.
 *
 * Bond posting is recorded, not enforced on-chain; the on-chain escrow is out of scope.
 */
@Injectable()
export class DisputeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DisputeService.name);
  private readonly windows = parseDisputeWindows(process.env.DISPUTE_WINDOW_HOURS);

  constructor(
    private readonly db: DatabaseService,
    private readonly metrics: MetricsService,
    @Optional() private readonly trust?: TrustEventsService,
  ) {}

  /** Seeds the gauge from the database so a restart does not report zero open disputes. */
  onApplicationBootstrap(): Promise<void> {
    return this.refreshOpenGauge();
  }

  windowHoursFor(coverageType: string): number {
    return this.windows[coverageType] ?? this.windows.default ?? DEFAULT_WINDOW_HOURS;
  }

  async open(input: OpenDisputeInput): Promise<DisputeRecord> {
    const disputeId = await this.inTransaction(async (client) => {
      const settlement = (
        await client.query<{ status: string; policyId: string; coverageType: string }>(
          `SELECT cs.status, cs.policy_id AS "policyId", p.coverage_type::text AS "coverageType"
             FROM claim_settlements cs
             JOIN policies p ON p.id = cs.policy_id
            WHERE cs.decision_id = $1
            FOR UPDATE OF cs`,
          [input.decisionId]
        )
      ).rows[0];
      if (!settlement) throw new NotFoundException(`Unknown decision ${input.decisionId}`);
      if (settlement.status === "pending" || settlement.status === "submitted") {
        throw new ConflictException(`Settlement for ${input.decisionId} is in flight; retry after reconciliation`);
      }
      if (settlement.status !== "confirmed") {
        throw new ConflictException(`Decision ${input.decisionId} did not pay out (settlement ${settlement.status})`);
      }

      const windowSeconds = this.windowHoursFor(settlement.coverageType) * 3600;
      const timing = (
        await client.query<{ closed: boolean }>(
          `SELECT now() >= created_at + make_interval(secs => $2) AS closed
             FROM claim_settlements WHERE decision_id = $1`,
          [input.decisionId, windowSeconds]
        )
      ).rows[0];
      if (timing.closed) throw new ConflictException(`Challenge window for ${input.decisionId} has closed`);

      try {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO claim_disputes (decision_id, policy_id, reason, bond_reference, opened_by, window_closes_at)
           VALUES ($1, $2, $3, $4, $5,
                   (SELECT created_at + make_interval(secs => $6) FROM claim_settlements WHERE decision_id = $1))
           RETURNING id`,
          [input.decisionId, settlement.policyId, input.reason, input.bondReference, input.actor, windowSeconds]
        );
        return inserted.rows[0].id;
      } catch (err) {
        if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new ConflictException(`Decision ${input.decisionId} already has a live dispute or is final`);
        }
        throw err;
      }
    });

    const record = await this.get(disputeId);
    await this.afterChange(record, "opened", input.actor);
    return record;
  }

  async transition(id: string, input: TransitionDisputeInput): Promise<DisputeRecord> {
    this.assertUuid(id);
    await this.inTransaction(async (client) => {
      const row = (
        await client.query<{ status: DisputeStatus; decisionId: string; policyId: string; settlementStatus: string; amount: string }>(
          `SELECT d.status, d.decision_id AS "decisionId", d.policy_id AS "policyId",
                  cs.status AS "settlementStatus", cs.amount::text AS amount
             FROM claim_disputes d
             JOIN claim_settlements cs ON cs.decision_id = d.decision_id
            WHERE d.id = $1
            FOR UPDATE OF d, cs`,
          [id]
        )
      ).rows[0];
      if (!row) throw new NotFoundException(`Unknown dispute ${id}`);
      if (!TRANSITIONS[row.status].includes(input.to)) {
        throw new ConflictException(`Cannot move dispute from ${row.status} to ${input.to}`);
      }

      if (input.to === "reversed") {
        if (!input.replacementDecisionId?.trim()) {
          throw new BadRequestException("replacementDecisionId is required to reverse a decision");
        }
        if (row.settlementStatus !== "confirmed") {
          throw new ConflictException(`Settlement for ${row.decisionId} is ${row.settlementStatus}; cannot reverse`);
        }
        // The original payout stays confirmed; the owed reconciliation is booked once per decision.
        await client.query(
          `INSERT INTO settlement_reversals (dispute_id, decision_id, policy_id, amount)
           VALUES ($1, $2, $3, $4)`,
          [id, row.decisionId, row.policyId, row.amount]
        );
      }

      const updated = await client.query(
        `UPDATE claim_disputes
            SET status = $2,
                resolution_note = COALESCE($3, resolution_note),
                replacement_decision_id = COALESCE($4, replacement_decision_id),
                bond_status = COALESCE($5, bond_status),
                resolved_at = CASE WHEN $6 THEN now() ELSE resolved_at END,
                updated_at = now()
          WHERE id = $1 AND status = $7`,
        [
          id,
          input.to,
          input.note ?? null,
          input.to === "reversed" ? input.replacementDecisionId!.trim() : null,
          BOND_ON_RESOLUTION[input.to] ?? null,
          input.to !== "under_review",
          row.status,
        ]
      );
      if (updated.rowCount === 0) throw new ConflictException(`Dispute ${id} changed concurrently; retry`);
    }).catch((err) => {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new ConflictException("Decision already reversed or replacement decision already in use");
      }
      throw err;
    });

    const record = await this.get(id);
    await this.afterChange(record, input.to, input.actor);
    return record;
  }

  async get(id: string): Promise<DisputeRecord> {
    this.assertUuid(id);
    const row = (await this.db.query<DisputeRow>(`${SELECT_DISPUTE} WHERE d.id = $1`, [id])).rows[0];
    if (!row) throw new NotFoundException(`Unknown dispute ${id}`);
    return toRecord(row);
  }

  /** Refreshes `refract_claim_disputes_open`. Failures are logged, never thrown into the request path. */
  async refreshOpenGauge(): Promise<void> {
    try {
      const { rows } = await this.db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM claim_disputes WHERE status IN ('open', 'under_review')`
      );
      this.metrics.recordOpenDisputes(Number(rows[0].count));
    } catch (err) {
      this.logger.warn(`Open-dispute gauge not refreshed: ${(err as Error).message}`);
    }
  }

  private async afterChange(
    record: DisputeRecord,
    kind: "opened" | Exclude<DisputeStatus, "open">,
    actor: string
  ): Promise<void> {
    await this.refreshOpenGauge();
    if (!this.trust) return;
    const event: TrustEventInput = {
      type: "trust.dispute",
      payload: { kind, coverageType: record.coverageType, disputeId: record.id },
      internal: { actor },
    };
    try {
      await this.trust.publish(event);
    } catch (err) {
      this.logger.warn(`Dispute event ${kind} not published: ${(err as Error).message}`);
    }
  }

  private async inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db.getClient();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private assertUuid(id: string): void {
    if (!UUID.test(id)) throw new NotFoundException(`Unknown dispute ${id}`);
  }
}

function toRecord(row: DisputeRow): DisputeRecord {
  const { reversalAmount, reversalStatus, ...dispute } = row;
  return {
    ...dispute,
    reversal: reversalAmount === null ? null : { amount: reversalAmount, status: reversalStatus ?? "owed" },
  };
}
