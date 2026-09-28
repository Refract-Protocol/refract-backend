import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { DepositDto } from "./dto/deposit.dto";
import { ListLpPositionsDto } from "./dto/list-lp-positions.dto";
import { WithdrawDto } from "./dto/withdraw.dto";
import { PoolService } from "./pool.service";

@ApiTags("Pool")
@Controller("api/v1/pool")
export class PoolController {
  constructor(private readonly poolService: PoolService) {}

  @Get("stats")
  @ApiOperation({ summary: "Get pool liquidity and utilization statistics" })
  @ApiResponse({ status: 200, description: "Pool statistics" })
  getStats() {
    return this.poolService.getStats();
  }

  @Get("user/:address")
  @ApiOperation({ summary: "Get a liquidity provider's position" })
  @ApiParam({ name: "address", description: "Stellar liquidity provider address" })
  @ApiResponse({ status: 200, description: "Liquidity provider position" })
  getUserPosition(@Param("address") address: string) {
    return this.poolService.getUserPosition(address);
  }

  @Get("positions")
  @ApiOperation({ summary: "List all liquidity-provider positions" })
  @ApiResponse({ status: 200, description: "Paginated LP positions sorted by committed capital" })
  listPositions(@Query() query: ListLpPositionsDto) {
    return this.poolService.listPositions(query);
  }

  /**
   * Real on-chain read (unlike stats/user, still mocked pending the
   * Postgres wiring) — lets the frontend show a withdrawal lockup
   * countdown before the caller ever attempts to submit one.
   */
  @Get("lockup/:address")
  @ApiOperation({ summary: "Get a provider's on-chain withdrawal lockup" })
  @ApiParam({ name: "address", description: "Stellar liquidity provider address" })
  @ApiResponse({ status: 200, description: "Lockup expiration timestamp, or null" })
  async getLockupStatus(@Param("address") address: string) {
    const lockupExpiresAt = await this.poolService.lockupExpiresAt(address);
    return { lockupExpiresAt: lockupExpiresAt !== null ? lockupExpiresAt.toString() : null };
  }

  @Post("provide")
  @ApiOperation({ summary: "Build an unsigned liquidity deposit transaction" })
  @ApiResponse({ status: 201, description: "Deposit estimate and unsigned transaction XDR" })
  provide(@Body() dto: DepositDto) {
    return this.poolService.provide(dto);
  }

  @Post("withdraw")
  @ApiOperation({ summary: "Build an unsigned liquidity withdrawal transaction" })
  @ApiResponse({ status: 201, description: "Withdrawal estimate and unsigned transaction XDR" })
  withdraw(@Body() dto: WithdrawDto) {
    return this.poolService.withdraw(dto);
  }

  @Get("premium-history")
  @ApiOperation({ summary: "Get pool premium and payout history" })
  @ApiResponse({ status: 200, description: "Daily premium and payout history" })
  getPremiumHistory() {
    return { history: this.poolService.getPremiumHistory() };
  }
}
