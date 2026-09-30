import { Controller, Get, Param } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { ClaimService } from "./claim.service";
import {
  ClaimStatsOpsResponseDto,
  ClaimStatsResponseDto,
} from "./dto/claim-stats.response";

/**
 * New in the NestJS migration — the pre-migration ClaimProcessor tracked
 * these stats internally but never exposed them over HTTP. Useful for
 * ops/observability, so it's kept as a small honest addition rather than
 * a pure like-for-like port.
 */
@Controller("api/v1/claims")
export class ClaimController {
  constructor(private readonly claimService: ClaimService) {}

  @Get("stats")
  getStats() {
    return plainToInstance(ClaimStatsResponseDto, this.claimService.getStats(), {
      excludeExtraneousValues: true,
    });
  }

  /**
   * Ops-only view of the stats. `settlementConfigured` is an operational
   * detail about the relayer and must not be served on the public stats
   * route above. Authentication for this route is handled separately.
   */
  @Get("stats/ops")
  getOpsStats() {
    return plainToInstance(
      ClaimStatsOpsResponseDto,
      this.claimService.getStats(),
      { excludeExtraneousValues: true },
    );
  }

  @Get("holder/:address")
  async getHistoryForHolder(@Param("address") address: string) {
    return { claims: await this.claimService.getHistoryForHolder(address) };
  }

  @Get("recent")
  async getRecent() {
    return { claims: await this.claimService.getRecentSettlements() };
  }
}
