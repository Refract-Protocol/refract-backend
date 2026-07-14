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
