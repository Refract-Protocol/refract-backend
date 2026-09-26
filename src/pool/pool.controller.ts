import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { DepositDto } from "./dto/deposit.dto";
import { WithdrawDto } from "./dto/withdraw.dto";
import { PoolService } from "./pool.service";

@Controller("api/v1/pool")
export class PoolController {
  constructor(private readonly poolService: PoolService) {}

  @Get("stats")
  async getStats() {
    return this.poolService.getStats();
  }

  @Get("user/:address")
  async getUserPosition(@Param("address") address: string) {
    return this.poolService.getUserPosition(address);
  }

  /**
   * On-chain lockup read via simulation — lets the frontend show a
   * withdrawal lockup countdown before the caller attempts to submit one.
   */
  @Get("lockup/:address")
  async getLockupStatus(@Param("address") address: string) {
    const lockupExpiresAt = await this.poolService.lockupExpiresAt(address);
    return { lockupExpiresAt: lockupExpiresAt !== null ? lockupExpiresAt.toString() : null };
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
