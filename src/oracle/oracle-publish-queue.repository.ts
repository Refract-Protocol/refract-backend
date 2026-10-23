import { Inject, Injectable } from "@nestjs/common";
import { Pool } from "pg";
import { PG_POOL } from "../db/db.module";

export interface PendingDecision {
  id: string;
  decisionKey: string;
  feed: string;
  valueScaled: bigint;
  priority: number;
  attempts: number;
  txHash: string | null;
}

export interface NewDecision {
  decisionKey: string;
  feed: string;
  valueScaled: bigint;
  priority: number;
}

export interface QueueDepth {
  high: number;
  low: number;
}

interface Row {
  id: string;
  decision_key: string;
  feed: string;
  value_scaled: string;
  priority: number;
  attempts: number;
  tx_hash: string | null;
}

const toDecision = (r: Row): PendingDecision => ({
  id: r.id,
  decisionKey: r.decision_key,
  feed: r.feed,
  valueScaled: BigInt(r.value_scaled),
  priority: r.priority,
  attempts: r.attempts,
  txHash: r.tx_hash,
});

/**
 * Durable pending-decisions queue (`oracle_publish_queue`). Producers only
 * call `enqueue`; the single-flight publisher owns every other transition.
 */
@Injectable()
export class OraclePublishQueueRepository {
  constructor(@Inject(PG_POOL) private readonly db: Pool) {}

  /** Idempotent on decisionKey. Returns false when the decision already existed. */
  async enqueue(decision: NewDecision): Promise<boolean> {
    const res = await this.db.query(
      `INSERT INTO oracle_publish_queue (decision_key, feed, value_scaled, priority)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (decision_key) DO NOTHING`,
      [decision.decisionKey, decision.feed, decision.valueScaled.toString(), decision.priority]
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Claims up to `limit` eligible rows (marking them inflight). Feeds are
   * ranked by their highest-priority unpublished decision, so a payout-
   * triggering feed drains first while each feed's rows stay a contiguous
   * prefix of its publish order. A row is only eligible when no earlier row of
   * the same feed is in flight or backing off, so a later decision can never
   * be claimed ahead of an earlier one. `perFeedCap` bounds how much of one
   * batch a single feed can take (fair scheduling).
   */
  async claim(limit: number, perFeedCap: number, excludeFeeds: string[]): Promise<PendingDecision[]> {
    const res = await this.db.query<Row>(
      `WITH open AS (
         SELECT id, feed, priority, status, next_attempt_at,
                max(priority) OVER (PARTITION BY feed) AS feed_priority,
                row_number() OVER (PARTITION BY feed ORDER BY id) AS rn
           FROM oracle_publish_queue
          WHERE status IN ('pending', 'inflight')
       ),
       picked AS (
         SELECT o.id FROM open o
          WHERE o.status = 'pending' AND o.next_attempt_at <= now()
            AND o.rn <= $3
            AND NOT (o.feed = ANY($2::text[]))
            AND NOT EXISTS (
              SELECT 1 FROM open e
               WHERE e.feed = o.feed AND e.id < o.id
                 AND (e.status = 'inflight' OR e.next_attempt_at > now())
            )
          ORDER BY o.feed_priority DESC, o.id
          LIMIT $1
       )
       UPDATE oracle_publish_queue q
          SET status = 'inflight', attempts = q.attempts + 1
         FROM picked
        WHERE q.id = picked.id
       RETURNING q.id, q.decision_key, q.feed, q.value_scaled, q.priority, q.attempts, q.tx_hash`,
      [limit, excludeFeeds, perFeedCap]
    );
    return res.rows.map(toDecision).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }

  async markPublished(ids: string[], txHash: string, ledger: number | null): Promise<void> {
    if (ids.length === 0) return;
    await this.db.query(
      `UPDATE oracle_publish_queue
          SET status = 'published', tx_hash = $2, ledger = $3, published_at = now(), last_error = NULL
        WHERE id = ANY($1::bigint[])`,
      [ids, txHash, ledger]
    );
  }

  /** Returns rows to pending with a backoff; optionally records the submitted tx hash for reconciliation. */
  async release(ids: string[], delayMs: number, error: string, txHash?: string): Promise<void> {
    if (ids.length === 0) return;
    await this.db.query(
      `UPDATE oracle_publish_queue
          SET status = 'pending', last_error = $3, tx_hash = COALESCE($4, tx_hash),
              next_attempt_at = now() + ($2 || ' milliseconds')::interval
        WHERE id = ANY($1::bigint[])`,
      [ids, String(Math.max(0, Math.round(delayMs))), error.slice(0, 500), txHash ?? null]
    );
  }

  /** Dead-letters a decision (kept for operator replay, never deleted). */
  async markFailed(ids: string[], error: string): Promise<void> {
    if (ids.length === 0) return;
    await this.db.query(
      `UPDATE oracle_publish_queue SET status = 'failed', last_error = $2 WHERE id = ANY($1::bigint[])`,
      [ids, error.slice(0, 500)]
    );
  }

  /** Startup recovery: rows left inflight by a crashed process go back to pending (tx_hash kept for reconcile). */
  async recoverInflight(): Promise<number> {
    const res = await this.db.query(
      `UPDATE oracle_publish_queue SET status = 'pending' WHERE status = 'inflight'`
    );
    return res.rowCount ?? 0;
  }

  async depth(): Promise<QueueDepth> {
    const res = await this.db.query<{ priority: number; n: string }>(
      `SELECT priority, count(*) AS n FROM oracle_publish_queue
        WHERE status IN ('pending', 'inflight') GROUP BY priority`
    );
    const depth: QueueDepth = { high: 0, low: 0 };
    for (const r of res.rows) {
      if (r.priority > 0) depth.high += Number(r.n);
      else depth.low += Number(r.n);
    }
    return depth;
  }
}
