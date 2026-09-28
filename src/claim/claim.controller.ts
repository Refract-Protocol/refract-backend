import { Controller, Get, Param, Query } from "@nestjs/common";
import { PageKey, PageQueryDto, paginateDesc } from "../common/pagination";
import { ClaimResult } from "./claim-result";
import { ClaimService } from "./claim.service";

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
    return this.claimService.getStats();
  }

  /** Newest first, keyset-paginated on (processedAt, policyId); `?limit=` defaults to 50. */
  @Get("holder/:address")
  getHistoryForHolder(@Param("address") address: string, @Query() query: PageQueryDto) {
    const page = paginateDesc(this.claimService.getHistoryForHolder(address), claimKey, query, 50);
    return { claims: page.items, nextCursor: page.nextCursor };
  }

  /** Newest first across all holders; `?limit=` defaults to 10, as before pagination. */
  @Get("recent")
  getRecent(@Query() query: PageQueryDto) {
    const page = paginateDesc(this.claimService.getRecentSettlements(Infinity), claimKey, query, 10);
    return { claims: page.items, nextCursor: page.nextCursor };
  }
}
