import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { DepositDto } from "./dto/deposit.dto";
import { WithdrawDto } from "./dto/withdraw.dto";
import { PoolService } from "./pool.service";
import { SecurityAudit } from "../common/security-audit.interceptor";

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

  @Post("provide")
  @SecurityAudit("pool.provide")
  provide(@Body() dto: DepositDto) {
    return this.poolService.provide(dto);
  }

  @Post("provide/simulate")
  simulateProvide(@Body() dto: DepositDto) {
    return this.poolService.simulateProvide(dto);
  }

  @Post("withdraw")
  @SecurityAudit("pool.withdraw")
  withdraw(@Body() dto: WithdrawDto) {
    return this.poolService.withdraw(dto);
  }

  @Post("withdraw/simulate")
  simulateWithdraw(@Body() dto: WithdrawDto) {
    return this.poolService.simulateWithdraw(dto);
  }

  @Get("premium-history")
  getPremiumHistory() {
    return { history: this.poolService.getPremiumHistory() };
  }
}
