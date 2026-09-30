import { Controller, Get, Param, Query } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { PageKey, PageQueryDto, paginateDesc } from "../common/pagination";
import { ClaimResult } from "./claim-result";
import { ClaimService } from "./claim.service";
import {
  ClaimStatsOpsResponseDto,
  ClaimStatsResponseDto,
} from "./dto/claim-stats.response";

/**
 * A policy settles at most once (it is deactivated on payout), so
 * policyId is a unique tie-breaker for claims sharing a processedAt.
 */
const claimKey = (c: ClaimResult): PageKey => ({ at: c.processedAt, id: c.policyId });

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

  /** Newest first, keyset-paginated on (processedAt, policyId); `?limit=` defaults to 50. */
  @Get("holder/:address")
  async getHistoryForHolder(@Param("address") address: string, @Query() query: PageQueryDto) {
    const page = paginateDesc(this.claimService.getHistoryForHolder(address), claimKey, query, 50);
    return { claims: page.items, nextCursor: page.nextCursor };
  }

  /** Newest first across all holders; `?limit=` defaults to 10, as before pagination. */
  @Get("recent")
  async getRecent(@Query() query: PageQueryDto) {
    const page = paginateDesc(this.claimService.getRecentSettlements(Infinity), claimKey, query, 10);
    return { claims: page.items, nextCursor: page.nextCursor };
  }
}
