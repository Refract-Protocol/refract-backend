import { Controller, Get, Param } from "@nestjs/common";
import { ClaimService } from "./claim.service";

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

  @Get("holder/:address")
  async getHistoryForHolder(@Param("address") address: string) {
    return { claims: await this.claimService.getHistoryForHolder(address) };
  }

  @Get("recent")
  async getRecent() {
    return { claims: await this.claimService.getRecentSettlements() };
  }
}
