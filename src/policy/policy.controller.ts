import { Controller, Get, NotFoundException, Param, Post, Body, Query } from "@nestjs/common";
import { PageQueryDto, paginateDesc } from "../common/pagination";
import { BuyPolicyDto } from "./dto/buy-policy.dto";
import { PolicyService } from "./policy.service";

@Controller("api/v1/policies")
export class PolicyController {
  constructor(private readonly policyService: PolicyService) {}

  @Get("types")
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
  async getCoverageBounds() {
    const bounds = await this.policyService.onChainCoverageBounds();
    return {
      minCoverage: bounds ? bounds.minCoverage.toString() : null,
      maxCoverage: bounds ? bounds.maxCoverage.toString() : null,
    };
  }

  /** Newest first, keyset-paginated on (createdAt, id); `?limit=` defaults to 50. */
  @Get("holder/:address")
  findByHolder(@Param("address") address: string, @Query() query: PageQueryDto) {
    const page = paginateDesc(
      this.policyService.findByHolder(address),
      (p) => ({ at: Date.parse(p.createdAt), id: p.id }),
      query,
      50
    );
    return { policies: page.items, nextCursor: page.nextCursor };
  }

  @Get(":id")
  findById(@Param("id") id: string) {
    const policy = this.policyService.findById(id);
    if (!policy) throw new NotFoundException({ error: "Policy not found" });
    return { policy };
  }

  @Post("buy")
  buy(@Body() dto: BuyPolicyDto) {
    return this.policyService.buy(dto);
  }
}
