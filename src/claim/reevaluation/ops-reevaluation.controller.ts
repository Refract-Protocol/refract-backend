import { Body, Controller, Get, HttpException, HttpStatus, Inject, Param, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from "@nestjs/common";
import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsInt, IsNumber, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from "class-validator";
import type { Request } from "express";
import { OpsAuthGuard } from "../../common/guards/ops-auth.guard";
import { DEFAULT_APPLY_BATCH, FeedStillUntrustedError, ReevaluationService, ReevaluationSettlementExecutor } from "./reevaluation.service";

const MAX_PAGE = 500;

function boundedInt(raw: string | undefined, fallback: number, max: number): number {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new HttpException({ error: "limit/offset must be non-negative integers" }, HttpStatus.BAD_REQUEST);
  return Math.min(n, max);
}

export const REEVALUATION_EXECUTOR = Symbol("REEVALUATION_EXECUTOR");

type OpsRequest = Request & { apiKey?: { name?: string } };

function actorOf(req: OpsRequest): string {
  return req.apiKey?.name ?? "ops";
}

export class PlanBackfillDto {
  @IsNumber()
  observedAt!: number;

  @IsNumber()
  value!: number;
}

export class PlanBody {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  feedId!: string;

  @IsOptional()
  @IsNumber()
  restoredAt?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10_000)
  @ValidateNested({ each: true })
  @Type(() => PlanBackfillDto)
  backfill?: PlanBackfillDto[];
}

export class ApproveReversalBody {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  note!: string;
}

/** Shared body validation: malformed input becomes a 400 naming the invalid field. */
const OPS_BODY_PIPE = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

/**
 * Operator view of re-evaluation runs: what was decided under an untrusted
 * feed, what trusted data says now, and the payout effect of each change.
 * Runs are planned automatically on trust restoration; applying one moves
 * money, so it's an explicit ops call.
 */
@Controller("api/v1/ops/reevaluations")
@UseGuards(OpsAuthGuard)
export class OpsReevaluationController {
  constructor(
    private readonly service: ReevaluationService,
    @Inject(REEVALUATION_EXECUTOR) private readonly executor: ReevaluationSettlementExecutor,
  ) {}

  @Get()
  list() {
    return this.service.listRuns().map(({ items: _items, itemStatus: _status, ...run }) => run);
  }

  /** One run with a page of its items (optionally only those whose outcome changed). */
  @Get(":runId")
  get(
    @Param("runId") runId: string,
    @Query("changedOnly") changedOnly?: string,
    @Query("offset") offsetRaw?: string,
    @Query("limit") limitRaw?: string,
  ) {
    const run = this.service.getRun(runId);
    if (!run) throw new HttpException({ error: "Unknown run" }, HttpStatus.NOT_FOUND);
    const onlyChanged = changedOnly === "true" || changedOnly === "1";
    const offset = boundedInt(offsetRaw, 0, Number.MAX_SAFE_INTEGER);
    const limit = Math.max(1, boundedInt(limitRaw, 100, MAX_PAGE));
    const filtered = run.items.filter((i) => !onlyChanged || i.changed);
    const items = filtered.slice(offset, offset + limit).map((i) => ({ ...i, ...run.itemStatus[i.recordId] }));
    return { ...run, items, itemStatus: undefined, page: { offset, limit, total: filtered.length } };
  }

  /** Manually plan a run, e.g. with operator-supplied backfill readings for a gap in quorum data. */
  @Post()
  @UsePipes(OPS_BODY_PIPE)
  plan(@Body() body: PlanBody) {
    const backfill = body.backfill ?? [];
    const now = Date.now();
    const restoredAt = Number.isFinite(body.restoredAt) ? (body.restoredAt as number) : now;
    let run;
    try {
      run = this.service.plan(body.feedId, restoredAt, now, backfill);
    } catch (err) {
      if (err instanceof FeedStillUntrustedError) throw new HttpException({ error: err.message }, HttpStatus.CONFLICT);
      throw err;
    }
    if (!run) throw new HttpException({ error: "No pending records for feed" }, HttpStatus.NOT_FOUND);
    return run;
  }

  /** Applies up to `limit` unfinished items (default 50). Call again to continue or retry failures. */
  @Post(":runId/apply")
  async apply(@Param("runId") runId: string, @Query("limit") limitRaw: string | undefined, @Req() req: OpsRequest) {
    if (!this.service.getRun(runId)) throw new HttpException({ error: "Unknown run" }, HttpStatus.NOT_FOUND);
    const limit = Math.max(1, boundedInt(limitRaw, DEFAULT_APPLY_BATCH, MAX_PAGE));
    try {
      const run = await this.service.apply(runId, this.executor, actorOf(req), Date.now(), limit);
      return { ...run, items: undefined };
    } catch (err) {
      throw new HttpException({ error: (err as Error).message }, HttpStatus.CONFLICT);
    }
  }

  /** Records explicit approval to reverse a flagged overpayment. Nothing is reversed automatically. */
  @Post(":runId/items/:recordId/approve-reversal")
  @UsePipes(OPS_BODY_PIPE)
  approveReversal(
    @Param("runId") runId: string,
    @Param("recordId") recordId: string,
    @Body() body: ApproveReversalBody,
    @Req() req: OpsRequest,
  ) {
    try {
      const run = this.service.approveReversal(runId, recordId, actorOf(req), body.note, Date.now());
      return { runId, recordId, status: run.itemStatus[recordId].status, audit: run.audit };
    } catch (err) {
      throw new HttpException({ error: (err as Error).message }, HttpStatus.BAD_REQUEST);
    }
  }
}
