import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards, UsePipes, ValidationPipe } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ClaimHold, ClaimHoldService, HoldStatus } from "./claim-hold.service";
import { ConsensusRoleGuard, ConsensusRoles } from "./consensus-role.guard";
import { ConsensusService } from "./consensus.service";
import {
  HoldDispositionDto,
  RecordReadingDto,
  RegisterSourceDto,
  SetQuorumPolicyDto,
  SignatureResultDto,
} from "./dto/consensus.dto";

const HOLD_STATUSES: HoldStatus[] = ["payout_held", "released", "escalated", "approved", "denied", "settled"];

/**
 * Operator surface for consensus governance and the payout-hold queue.
 * Writes require the operator role; auditors can read.
 */
@ApiTags("Ops / Consensus")
@Controller("api/v1/ops/consensus")
@UseGuards(ConsensusRoleGuard)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
export class ConsensusController {
  constructor(
    private readonly consensus: ConsensusService,
    private readonly holds: ClaimHoldService,
  ) {}

  @Post("sources")
  registerSource(@Body() dto: RegisterSourceDto) {
    return this.consensus.registerSource(dto);
  }

  @Post("quorum-policies")
  setQuorumPolicy(@Body() dto: SetQuorumPolicyDto) {
    return this.consensus.setQuorumPolicy(dto);
  }

  @Post("readings")
  recordReading(@Body() dto: RecordReadingDto) {
    return this.consensus.recordReading(dto);
  }

  @Post("readings/:readingId/signature")
  @HttpCode(204)
  recordSignature(@Param("readingId") readingId: string, @Body() dto: SignatureResultDto): void {
    this.consensus.recordSignatureResult(readingId, dto.result);
  }

  @Post("feeds/:feedId/decide")
  decide(@Param("feedId") feedId: string) {
    return this.consensus.decide(feedId);
  }

  /** Escalation queue: `?status=escalated` lists claims awaiting a disposition. */
  @Get("holds")
  @ConsensusRoles("operator", "auditor")
  listHolds(@Query("status") status?: string): { holds: ClaimHold[] } {
    const filter = HOLD_STATUSES.includes(status as HoldStatus) ? (status as HoldStatus) : undefined;
    return { holds: this.holds.list(filter) };
  }

  @Get("holds/:holdId")
  @ConsensusRoles("operator", "auditor")
  getHold(@Param("holdId") holdId: string): ClaimHold {
    return this.holds.get(holdId);
  }

  @Post("holds/:holdId/disposition")
  dispose(@Param("holdId") holdId: string, @Body() dto: HoldDispositionDto): ClaimHold {
    return this.holds.dispose(holdId, dto.disposition, dto.actor, dto.note, dto.extendMs);
  }

  @Post("holds/reevaluate")
  reevaluate() {
    return this.holds.reevaluateAll();
  }
}
