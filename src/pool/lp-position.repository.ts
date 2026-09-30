import { Injectable } from "@nestjs/common";
import { DbService } from "../db/db.service";

export interface CapitalFlowInput {
  provider: string;
  /** Absolute USDC amount moved in this event (1e7 units as bigint/string). */
  usdcAmount: bigint | string;
  /** Absolute share delta for this event. */
  sharesDelta: bigint | string;
}

/**
 * Projects LP provide/withdraw events onto `lp_positions`.
 */
@Injectable()
export class LpPositionRepository {
  constructor(private readonly db: DbService) {}

  async applyProvide(input: CapitalFlowInput): Promise<void> {
    const usdc = input.usdcAmount.toString();
    const shares = input.sharesDelta.toString();
    await this.db.query(
      `INSERT INTO lp_positions (provider, shares, usdc_deposited, premium_earned, first_deposit, last_updated)
       VALUES ($1, $2, $3, 0, NOW(), NOW())
       ON CONFLICT (provider) DO UPDATE SET
         shares = lp_positions.shares + EXCLUDED.shares,
         usdc_deposited = lp_positions.usdc_deposited + EXCLUDED.usdc_deposited,
         last_updated = NOW()`,
      [input.provider, shares, usdc]
    );
  }

  async applyWithdraw(input: CapitalFlowInput): Promise<void> {
    const usdc = input.usdcAmount.toString();
    const shares = input.sharesDelta.toString();
    await this.db.query(
      `INSERT INTO lp_positions (provider, shares, usdc_deposited, premium_earned, first_deposit, last_updated)
       VALUES ($1, 0, 0, 0, NOW(), NOW())
       ON CONFLICT (provider) DO UPDATE SET
         shares = GREATEST(lp_positions.shares - $2::numeric, 0),
         usdc_deposited = GREATEST(lp_positions.usdc_deposited - $3::numeric, 0),
         last_updated = NOW()`,
      [input.provider, shares, usdc]
    );
  }
}
