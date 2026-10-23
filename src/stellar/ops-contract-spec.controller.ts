import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { AdminOnly } from "../common/admin-auth";
import { AdminApiKeyGuard } from "../common/admin-auth";
import { ContractSpecRevalidator } from "./contract-spec-revalidator";

interface OverrideDto {
  reason: string;
  actor: string;
}

/**
 * Admin endpoints for contract spec revalidation and the diff report.
 *
 * GET  /ops/contracts/diff-report     — current diff report (last revalidation)
 * POST /ops/contracts/revalidate      — trigger an immediate revalidation
 * POST /ops/contracts/override        — operator override to clear a block
 * POST /ops/contracts/override/clear  — remove the operator override
 */
@Controller("ops/contracts")
@UseGuards(AdminApiKeyGuard)
export class OpsContractSpecController {
  constructor(private readonly revalidator: ContractSpecRevalidator) {}

  @Get("diff-report")
  @AdminOnly()
  getDiffReport() {
    const result = this.revalidator.getLastResult();
    if (!result) {
      return { message: "No revalidation has run yet" };
    }
    return result;
  }

  @Post("revalidate")
  @AdminOnly()
  @HttpCode(HttpStatus.OK)
  async revalidate() {
    return this.revalidator.revalidate();
  }

  /**
   * Operator override: clears the publication/settlement block with a reason
   * and actor recorded for the audit trail.
   */
  @Post("override")
  @AdminOnly()
  @HttpCode(HttpStatus.OK)
  async applyOverride(@Body() dto: OverrideDto) {
    await this.revalidator.applyOperatorOverride(dto.reason, dto.actor);
    return { message: "Override applied. Block cleared until next revalidation.", ...dto };
  }

  @Post("override/clear")
  @AdminOnly()
  @HttpCode(HttpStatus.OK)
  async clearOverride() {
    await this.revalidator.clearOperatorOverride();
    return { message: "Operator override removed." };
  }
}
