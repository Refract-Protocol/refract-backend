import { BadRequestException, Body, Controller, Get, Module, Param, Post, UseGuards } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { OpsAuthGuard } from "../common/guards/ops-auth.guard";
import { DbService } from "../db/db.service";
import {
  OracleSubmission,
  StakingService,
  SubmissionContext,
  parseAmount,
} from "../services/staking";

interface SubmissionBody {
  evidenceId: string;
  operatorId: string;
  feedId: string;
  roundId: string;
  value: string;
  submittedAt: string;
}

interface EvaluateBody {
  submission: SubmissionBody;
  siblings?: SubmissionBody[];
  context: { consensus: string | null; toleranceBps: number; quarantinedAt: string | null };
}

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BadRequestException(`${field} is required`);
  }
  return value;
};

const parseDate = (value: unknown, field: string): Date => {
  const date = new Date(requireString(value, field));
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`${field} must be an ISO-8601 timestamp`);
  return date;
};

const toSubmission = (body: SubmissionBody): OracleSubmission => ({
  evidenceId: requireString(body.evidenceId, "evidenceId"),
  operatorId: requireString(body.operatorId, "operatorId"),
  feedId: requireString(body.feedId, "feedId"),
  roundId: requireString(body.roundId, "roundId"),
  value: BigInt(requireString(body.value, "value")),
  submittedAt: parseDate(body.submittedAt, "submittedAt"),
});

/**
 * Operator staking and slashing API. Reads and writes are ops-authenticated
 * until operator-scoped auth exists. Bond and unbond records mirror confirmed
 * staking-contract events; the backend never moves funds itself.
 */
@ApiExcludeController()
@Controller("api/v1/staking")
@UseGuards(OpsAuthGuard)
export class StakingController {
  constructor(private readonly staking: StakingService) {}

  @Get("operators/:operatorId")
  getStatus(@Param("operatorId") operatorId: string) {
    return this.staking.getStatus(operatorId);
  }

  @Post("operators/:operatorId/bonds")
  async recordBond(@Param("operatorId") operatorId: string, @Body() body: { amount?: unknown }) {
    await this.staking.recordBond(operatorId, body?.amount);
    return this.staking.getStatus(operatorId);
  }

  @Post("operators/:operatorId/unbond")
  requestUnbond(@Param("operatorId") operatorId: string, @Body() body: { amount?: unknown }) {
    return this.staking.requestUnbond(operatorId, body?.amount);
  }

  @Post("operators/:operatorId/withdraw")
  withdraw(@Param("operatorId") operatorId: string) {
    return this.staking.withdraw(operatorId);
  }

  @Post("slashing/evaluate")
  evaluate(@Body() body: EvaluateBody) {
    const submission = toSubmission(body.submission);
    const siblings = (body.siblings ?? []).map(toSubmission);
    const context: SubmissionContext = {
      consensus: body.context?.consensus == null ? null : parseAmount(body.context.consensus, "consensus"),
      toleranceBps: Number(body.context?.toleranceBps),
      quarantinedAt: body.context?.quarantinedAt == null ? null : parseDate(body.context.quarantinedAt, "quarantinedAt"),
    };
    if (!Number.isInteger(context.toleranceBps) || context.toleranceBps < 0) {
      throw new BadRequestException("toleranceBps must be a non-negative integer");
    }
    return this.staking.evaluateSubmission(submission, siblings, context);
  }

  @Post("slashing/proposals/:proposalId/approve")
  approve(@Param("proposalId") proposalId: string, @Body() body: { reviewer?: unknown }) {
    return this.staking.approveProposal(proposalId, requireString(body?.reviewer, "reviewer"));
  }

  @Post("slashing/proposals/:proposalId/reject")
  reject(@Param("proposalId") proposalId: string, @Body() body: { reviewer?: unknown }) {
    return this.staking.rejectProposal(proposalId, requireString(body?.reviewer, "reviewer"));
  }

  @Post("slashing/proposals/:proposalId/appeal")
  appeal(@Param("proposalId") proposalId: string) {
    return this.staking.appealProposal(proposalId);
  }

  @Post("slashing/proposals/:proposalId/execute")
  execute(@Param("proposalId") proposalId: string, @Body() body: { txHash?: unknown }) {
    return this.staking.executeProposal(proposalId, requireString(body?.txHash, "txHash"));
  }
}

@Module({
  controllers: [StakingController],
  providers: [DbService, StakingService],
  exports: [StakingService],
})
export class StakingModule {}
