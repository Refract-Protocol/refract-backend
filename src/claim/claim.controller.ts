import { Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { OpsAuthGuard } from "../common/guards/ops-auth.guard";
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
  getHistoryForHolder(@Param("address") address: string) {
    return { claims: this.claimService.getHistoryForHolder(address) };
  }

  @Get("recent")
  getRecent() {
    return { claims: this.claimService.getRecentSettlements() };
  }

  /** Ops: list dead-lettered claims with full error history. */
  @Get("ops/dead-letter")
  @UseGuards(OpsAuthGuard)
  listDeadLettered() {
    return { claims: this.claimService.listDeadLettered() };
  }

  /** Ops: manually requeue a dead-lettered claim for another settlement attempt. */
  @Post("ops/dead-letter/:policyId/requeue")
  @UseGuards(OpsAuthGuard)
  requeue(@Param("policyId") policyId: string) {
    return this.claimService.requeueDeadLetter(policyId);
  }
}
