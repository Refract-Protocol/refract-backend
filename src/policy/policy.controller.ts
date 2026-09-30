import { Controller, Get, NotFoundException, Param, Post, Body, Query } from "@nestjs/common";
import { BuyPolicyDto } from "./dto/buy-policy.dto";
import { ListPoliciesDto } from "./dto/list-policies.dto";
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

  /**
   * Returns a paginated, filterable, sortable list of policies for a holder.
   *
   * Query params (all optional):
   *   page        – 1-based page number (default 1)
   *   limit       – results per page, 1–100 (default 20)
   *   isActive    – "true" | "false" — filter by active status
   *   coverageType – 0–4 — filter by coverage type
   *   sortBy      – createdAt | expiresAt | coverageAmount | premium (default createdAt)
   *   sortDir     – asc | desc (default desc)
   */
  @Get("holder/:address")
  findByHolder(@Param("address") address: string, @Query() query: ListPoliciesDto) {
    return this.policyService.findByHolder(address, query);
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
