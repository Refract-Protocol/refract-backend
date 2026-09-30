import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { DepositDto } from "./dto/deposit.dto";
import { WithdrawDto } from "./dto/withdraw.dto";
import { PoolService } from "./pool.service";

@Controller("api/v1/pool")
export class PoolController {
  constructor(private readonly poolService: PoolService) {}

  @Get("stats")
  getStats() {
    return this.poolService.getStats();
  }

  /**
   * Real on-chain read: consolidates the provider's share balance,
   * premium entitlement, and lockup expiry into a single response so
   * the frontend needs one call instead of two. A provider with no
   * position yields an explicit zero-position (distinguishable from an
   * error and from an unconfigured contract), matching the honest
   * `null` semantics of `lockupExpiresAt`.
   */
  @Get("user/:address")
  async getUserPosition(@Param("address") address: string) {
    const position = await this.poolService.getUserPosition(address);
    return {
      address: position.address,
      shares: position.shares.toString(),
      usdcValue: position.usdcValue.toString(),
      premiumEarned: position.premiumEarned.toString(),
      pct: position.pct,
      lockupExpiresAt:
        position.lockupExpiresAt !== null ? position.lockupExpiresAt.toString() : null,
      readAt: position.readAt,
    };
  }

  /**
   * Real on-chain read (unlike stats, still mocked pending the
   * Postgres wiring) — lets the frontend show a withdrawal lockup
   * countdown before the caller ever attempts to submit one.
   */
  @Get("lockup/:address")
  async getLockupStatus(@Param("address") address: string) {
    const lockupExpiresAt = await this.poolService.lockupExpiresAt(address);
    return { lockupExpiresAt: lockupExpiresAt !== null ? lockupExpiresAt.toString() : null };
  }

  /**
   * Returns the full LP event history for a provider address, newest first.
   *
   * Every provide_capital and withdraw_capital tx preparation appends an
   * entry here so LP balance changes are auditable even before the Postgres
   * repository is wired.  When the DB layer lands, this endpoint will be
   * backed by a paginated SELECT from lp_position_events.
   */
  @Get("events/:address")
  getEventsForProvider(@Param("address") address: string) {
    return { events: this.poolService.getEventsForProvider(address) };
  }

  @Post("provide")
  provide(@Body() dto: DepositDto) {
    return this.poolService.provide(dto);
  }

  @Post("withdraw")
  withdraw(@Body() dto: WithdrawDto) {
    return this.poolService.withdraw(dto);
  }

  @Get("premium-history")
  getPremiumHistory() {
    return { history: this.poolService.getPremiumHistory() };
  }
}
