import { Controller, Get, Param } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { ClaimService } from "./claim.service";

/**
 * New in the NestJS migration — the pre-migration ClaimProcessor tracked
 * these stats internally but never exposed them over HTTP. Useful for
 * ops/observability, so it's kept as a small honest addition rather than
 * a pure like-for-like port.
 */
@ApiTags("Claims")
@Controller("api/v1/claims")
export class ClaimController {
  constructor(private readonly claimService: ClaimService) {}

  @Get("stats")
  @ApiOperation({ summary: "Get claim processing statistics" })
  @ApiResponse({ status: 200, description: "Claim processor statistics" })
  getStats() {
    return this.claimService.getStats();
  }

  @Get("holder/:address")
  @ApiOperation({ summary: "List settled claims for a holder" })
  @ApiParam({ name: "address", description: "Stellar holder address" })
  @ApiResponse({ status: 200, description: "Settled claims for the holder" })
  getHistoryForHolder(@Param("address") address: string) {
    return { claims: this.claimService.getHistoryForHolder(address) };
  }

  @Get("recent")
  @ApiOperation({ summary: "List recent claim settlements" })
  @ApiResponse({ status: 200, description: "Recent settled claims" })
  getRecent() {
    return { claims: this.claimService.getRecentSettlements() };
  }
}
