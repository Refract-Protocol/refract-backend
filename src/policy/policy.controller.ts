import { Controller, Get, NotFoundException, Param, Post, Body } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { BuyPolicyDto } from "./dto/buy-policy.dto";
import { PolicyService } from "./policy.service";

@ApiTags("Policies")
@Controller("api/v1/policies")
export class PolicyController {
  constructor(private readonly policyService: PolicyService) {}

  @Get("types")
  @ApiOperation({ summary: "List policy coverage types" })
  @ApiResponse({ status: 200, description: "Coverage type catalog" })
  listTypes() {
    return { coverageTypes: this.policyService.listTypes() };
  }

  /**
   * Real on-chain read (unlike listTypes()'s per-type catalog, which is
   * this service's own static product policy) — the pool enforces a
   * single global min/max coverage across every type, so the frontend
   * needs this to validate a coverageAmount before ever building a tx.
   * Registered ahead of the :id route below so "coverage-bounds" isn't
   * swallowed as a policy id.
   */
  @Get("coverage-bounds")
  @ApiOperation({ summary: "Read current on-chain coverage bounds" })
  @ApiResponse({ status: 200, description: "Minimum and maximum coverage amounts" })
  async getCoverageBounds() {
    const bounds = await this.policyService.onChainCoverageBounds();
    return {
      minCoverage: bounds ? bounds.minCoverage.toString() : null,
      maxCoverage: bounds ? bounds.maxCoverage.toString() : null,
    };
  }

  @Get("holder/:address")
  @ApiOperation({ summary: "List policies for a holder" })
  @ApiParam({ name: "address", description: "Stellar holder address" })
  @ApiResponse({ status: 200, description: "Policies belonging to the holder" })
  findByHolder(@Param("address") address: string) {
    return { policies: this.policyService.findByHolder(address) };
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a policy by ID" })
  @ApiParam({ name: "id", description: "Policy identifier" })
  @ApiResponse({ status: 200, description: "Policy details" })
  @ApiResponse({ status: 404, description: "Policy not found" })
  findById(@Param("id") id: string) {
    const policy = this.policyService.findById(id);
    if (!policy) throw new NotFoundException({ error: "Policy not found" });
    return { policy };
  }

  @Post("buy")
  @ApiOperation({ summary: "Build an unsigned policy purchase transaction" })
  @ApiResponse({ status: 201, description: "Policy details and unsigned transaction XDR" })
  buy(@Body() dto: BuyPolicyDto) {
    return this.policyService.buy(dto);
  }
}
