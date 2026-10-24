import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { OpsAuthGuard } from "../../common/guards/ops-auth.guard";
import { DisputeService, TransitionDisputeInput } from "./dispute.service";

type OpsRequest = Request & { apiKey?: { name?: string } };

const requireString = (value: unknown, field: string, max: number): string => {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new BadRequestException(`${field} is required (max ${max} characters)`);
  }
  return value.trim();
};

const optionalString = (value: unknown, field: string, max: number): string | undefined =>
  value === undefined || value === null ? undefined : requireString(value, field, max);

const RESOLUTIONS = ["under_review", "upheld", "reversed", "withdrawn"] as const;

/**
 * Bonded challenge API for payout decisions. Every route is ops-authenticated:
 * a bond must be posted by a known operator before a dispute is recorded, so
 * anonymous callers cannot open disputes against bonds they never posted.
 * Operator-scoped auth and on-chain bond verification are follow-ups.
 */
@ApiTags("disputes")
@Controller("api/v1/disputes")
@UseGuards(OpsAuthGuard)
export class DisputeController {
  constructor(private readonly disputes: DisputeService) {}

  @ApiOperation({ summary: "Open a bonded challenge against a payout decision inside its window" })
  @Post()
  open(@Req() req: OpsRequest, @Body() body: { decisionId?: unknown; reason?: unknown; bondReference?: unknown }) {
    return this.disputes.open({
      decisionId: requireString(body?.decisionId, "decisionId", 256),
      reason: requireString(body?.reason, "reason", 2000),
      bondReference: requireString(body?.bondReference, "bondReference", 256),
      actor: req.apiKey?.name ?? "ops",
    });
  }

  @ApiOperation({ summary: "Get a dispute's status, bond state and reversal link" })
  @Get(":id")
  get(@Param("id") id: string) {
    return this.disputes.get(id);
  }

  @ApiOperation({
    summary: "Move a dispute to under_review, upheld, reversed or withdrawn",
    description:
      "Reversal requires replacementDecisionId: the recomputed decision that supersedes the disputed one. " +
      "The original settlement and evidence are not modified.",
  })
  @Post(":id/transitions")
  transition(
    @Req() req: OpsRequest,
    @Param("id") id: string,
    @Body() body: { to?: unknown; note?: unknown; replacementDecisionId?: unknown },
  ) {
    const to = body?.to;
    if (typeof to !== "string" || !(RESOLUTIONS as readonly string[]).includes(to)) {
      throw new BadRequestException(`to must be one of ${RESOLUTIONS.join(", ")}`);
    }
    const input: TransitionDisputeInput = {
      to: to as TransitionDisputeInput["to"],
      note: optionalString(body.note, "note", 2000),
      replacementDecisionId: optionalString(body.replacementDecisionId, "replacementDecisionId", 256),
      actor: req.apiKey?.name ?? "ops",
    };
    return this.disputes.transition(id, input);
  }
}
