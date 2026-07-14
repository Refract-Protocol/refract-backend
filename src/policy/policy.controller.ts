import { Controller, Get, NotFoundException, Param, Post, Body } from "@nestjs/common";
import { BuyPolicyDto } from "./dto/buy-policy.dto";
import { PolicyService } from "./policy.service";

@Controller("api/v1/policies")
export class PolicyController {
  constructor(private readonly policyService: PolicyService) {}

  @Get("types")
  listTypes() {
    return { coverageTypes: this.policyService.listTypes() };
  }

  @Get("holder/:address")
  findByHolder(@Param("address") address: string) {
    return { policies: this.policyService.findByHolder(address) };
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
