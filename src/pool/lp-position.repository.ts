import { Inject, Injectable, Logger } from "@nestjs/common";
import { Pool } from "pg";
import { PG_POOL } from "../db/db.module";

export interface LpPosition {
  provider: string;
  shares: bigint;
  usdcDeposited: bigint;
  premiumEarned: bigint;
  firstDeposit: Date;
  lastUpdated: Date;
}

/**
 * Reads from and writes to the `lp_positions` table defined in
 * src/db/schema.sql (provider UNIQUE, shares, usdc_deposited,
 * premium_earned, first_deposit, last_updated).
 */
@Injectable()
export class LpPositionRepository {
  private readonly logger = new Logger(LpPositionRepository.name);

  constructor(@Inject(PG_POOL) private readonly db: Pool) {}

  /**
   * Returns the LP position for `provider`, or null if they have never
   * deposited (no row in lp_positions).
   */
  async findByProvider(provider: string): Promise<LpPosition | null> {
    try {
      const { rows } = await this.db.query<{
        provider: string;
        shares: string;
        usdc_deposited: string;
        premium_earned: string;
        first_deposit: Date;
        last_updated: Date;
      }>(
        `SELECT provider, shares, usdc_deposited, premium_earned,
                first_deposit, last_updated
         FROM lp_positions
         WHERE provider = $1`,
        [provider]
      );
      if (rows.length === 0) return null;
      const row = rows[0];
      return {
        provider: row.provider,
        shares: BigInt(row.shares),
        usdcDeposited: BigInt(row.usdc_deposited),
        premiumEarned: BigInt(row.premium_earned),
        firstDeposit: row.first_deposit,
        lastUpdated: row.last_updated,
      };
    } catch (err) {
      this.logger.error(
        `Failed to read LP position for ${provider}`,
        err instanceof Error ? err.message : String(err)
      );
      return null;
    }
  }

  /**
   * Upserts an LP position row. Used by the provide/withdraw flow to keep
   * shares and deposited amounts current.
   */
  async upsert(position: Omit<LpPosition, "firstDeposit" | "lastUpdated">): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO lp_positions (provider, shares, usdc_deposited, premium_earned)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (provider) DO UPDATE SET
           shares         = EXCLUDED.shares,
           usdc_deposited = EXCLUDED.usdc_deposited,
           premium_earned = EXCLUDED.premium_earned,
           last_updated   = NOW()`,
        [
          position.provider,
          position.shares.toString(),
          position.usdcDeposited.toString(),
          position.premiumEarned.toString(),
        ]
      );
    } catch (err) {
      this.logger.error(
        `Failed to upsert LP position for ${position.provider}`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
}
