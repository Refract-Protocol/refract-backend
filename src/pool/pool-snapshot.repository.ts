import { Inject, Injectable, Logger } from "@nestjs/common";
import { Pool } from "pg";
import { PG_POOL } from "../db/db.module";
import { PoolStats } from "./pool.service";

interface PoolSnapshot {
  totalUsdc: bigint;
  totalShares: bigint;
  lockedUsdc: bigint;
  premiumAccrued: bigint;
  sharePrice: number;
  utilizationBps: number;
  apyBps: number;
}

/**
 * Reads from and writes to the `pool_snapshots` table defined in
 * src/db/schema.sql.
 *
 * The snapshot writer (upsertLatest) is called by PoolSnapshotScheduler on
 * a schedule. The reader (getLatest) is used by PoolService.getStats() and
 * the share-math in provide()/withdraw().
 */
@Injectable()
export class PoolSnapshotRepository {
  private readonly logger = new Logger(PoolSnapshotRepository.name);

  constructor(@Inject(PG_POOL) private readonly db: Pool) {}

  /**
   * Returns the most recent pool snapshot, or null if the table is empty
   * (i.e. the scheduler hasn't run yet or the DB is freshly initialised).
   */
  async getLatest(): Promise<PoolSnapshot | null> {
    try {
      const { rows } = await this.db.query<{
        total_usdc: string;
        total_shares: string;
        locked_usdc: string;
        premium_accrued: string;
        share_price: string;
        utilization_bps: number;
        apy_bps: number;
      }>(
        `SELECT total_usdc, total_shares, locked_usdc, premium_accrued,
                share_price, utilization_bps, apy_bps
         FROM pool_snapshots
         ORDER BY snapshotted_at DESC
         LIMIT 1`
      );
      if (rows.length === 0) return null;
      const row = rows[0];
      return {
        totalUsdc: BigInt(row.total_usdc),
        totalShares: BigInt(row.total_shares),
        lockedUsdc: BigInt(row.locked_usdc),
        premiumAccrued: BigInt(row.premium_accrued),
        sharePrice: parseFloat(row.share_price),
        utilizationBps: row.utilization_bps,
        apyBps: row.apy_bps,
      };
    } catch (err) {
      this.logger.error("Failed to read latest pool snapshot", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * Inserts a new pool snapshot row. Called on a schedule (e.g. every 5
   * minutes) so stats stay current without requiring on-chain reads for
   * every API call.
   */
  async insert(snapshot: PoolSnapshot): Promise<void> {
    const utilizationBps =
      snapshot.totalUsdc > 0n
        ? Number((snapshot.lockedUsdc * 10_000n) / snapshot.totalUsdc)
        : 0;

    // APY from premiums: (premiumAccrued / totalUsdc) * 52 (weekly cadence)
    // expressed in bps. This is the same formula the old mock hardcoded at
    // 890bps — now derived from real data.
    const apyBps =
      snapshot.totalUsdc > 0n
        ? Math.round((Number(snapshot.premiumAccrued) / Number(snapshot.totalUsdc)) * 52 * 10_000)
        : 0;

    const sharePrice =
      snapshot.totalShares > 0n
        ? Number(snapshot.totalUsdc) / Number(snapshot.totalShares)
        : 1.0;

    try {
      await this.db.query(
        `INSERT INTO pool_snapshots
           (total_usdc, total_shares, locked_usdc, premium_accrued,
            share_price, utilization_bps, apy_bps)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          snapshot.totalUsdc.toString(),
          snapshot.totalShares.toString(),
          snapshot.lockedUsdc.toString(),
          snapshot.premiumAccrued.toString(),
          sharePrice.toFixed(7),
          utilizationBps,
          apyBps,
        ]
      );
    } catch (err) {
      this.logger.error("Failed to insert pool snapshot", err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Converts a DB snapshot to the PoolStats shape PoolService returns.
   */
  toStats(snapshot: PoolSnapshot): PoolStats {
    return {
      totalUsdc: snapshot.totalUsdc.toString(),
      totalShares: snapshot.totalShares.toString(),
      lockedUsdc: snapshot.lockedUsdc.toString(),
      premiumAccrued: snapshot.premiumAccrued.toString(),
      availableUsdc: (snapshot.totalUsdc - snapshot.lockedUsdc).toString(),
      utilizationBps: snapshot.utilizationBps,
      apyBps: snapshot.apyBps,
      sharePrice: snapshot.sharePrice,
      maxUtilizationBps: 8000,
    };
  }
}
