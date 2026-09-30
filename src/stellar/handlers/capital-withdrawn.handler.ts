import { Injectable } from "@nestjs/common";
import { LpPositionRepository } from "../../pool/lp-position.repository";
import { DecodedContractEvent, asBigInt, asRecord, asString } from "./event-types";

/**
 * Projects a `capital_withdrawn` contract event into `lp_positions`.
 *
 * Assumed topics: [..., "capital_withdrawn"] (Symbol).
 * Assumed value map keys:
 *   provider (Address), amount / usdc_amount (i128), shares (i128).
 */
@Injectable()
export class CapitalWithdrawnHandler {
  constructor(private readonly positions: LpPositionRepository) {}

  async handle(event: DecodedContractEvent): Promise<void> {
    const v = asRecord(event.value);
    const provider = asString(v.provider, "provider");
    const usdcAmount = asBigInt(v.usdc_amount ?? v.amount ?? v.usdcAmount, "usdc_amount");
    const shares = asBigInt(v.shares, "shares");

    await this.positions.applyWithdraw({
      provider,
      usdcAmount,
      sharesDelta: shares,
    });
  }
}
