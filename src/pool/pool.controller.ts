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

  @Get("user/:address")
  getUserPosition(@Param("address") address: string) {
    return this.poolService.getUserPosition(address);
  }

  /**
   * Real on-chain read (unlike stats/user, still mocked pending the
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
