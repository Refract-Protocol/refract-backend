import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { z } from "zod";
import { OracleConfigParseError, parseOracleConfig } from "../config/oracle-feed-config";
import { SourceBootstrapService } from "../bootstrap/source-bootstrap.service";
import { OracleAuditLog, currentActor } from "./oracle-audit";
import {
  ControlConflictError,
  ControlNotFoundError,
  ControlValidationError,
  OracleControlRegistry,
} from "./oracle-control.registry";
import {
  OperatorRequest,
  OperatorRoute,
  OracleAuditInterceptor,
  OracleOperatorGuard,
} from "./oracle-operator.guard";

const reason = z.string().trim().min(3).max(500);
const revision = z.number().int().positive().optional();

const quorumBody = z
  .object({
    trustMode: z.string().optional(),
    minSources: z.number().int(),
    maxDeviationBps: z.number().int().optional(),
    expectedRevision: revision,
  })
  .strict();
const pauseBody = z.object({ reason }).strict();
const resumeBody = z.object({ reason: reason.optional() }).strict();
const quarantineBody = z
  .object({
    action: z.enum(["quarantine", "release"]),
    reason,
    expiresAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
const manualOverrideBody = z
  .object({ value: z.number(), reason, expiresAt: z.string().datetime({ offset: true }) })
  .strict();
const bootstrapBody = z.object({ force: z.boolean().optional() }).strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException({
      error: "Invalid request body",
      issues: result.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`),
    });
  }
  return result.data;
}

/** Maps registry errors to HTTP. */
function run<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ControlNotFoundError) throw new NotFoundException({ error: error.message });
    if (error instanceof ControlConflictError) throw new ConflictException({ error: error.message });
    if (error instanceof ControlValidationError) {
      throw new UnprocessableEntityException({ error: error.message, issues: error.issues });
    }
    throw error;
  }
}

/**
 * Operator-facing oracle controls. Every route needs an operator API key
 * (see OracleOperatorGuard) and is written to the audit trail.
 */
@Controller("api/v1/oracle/admin")
@UseGuards(OracleOperatorGuard)
@UseInterceptors(OracleAuditInterceptor)
export class OracleAdminController {
  constructor(
    private readonly registry: OracleControlRegistry,
    private readonly bootstrap: SourceBootstrapService,
    private readonly audit: OracleAuditLog
  ) {}

  @Get("whoami")
  @OperatorRoute("feeds:read", "operator.whoami")
  whoami(@Req() req: OperatorRequest) {
    return req.oracleOperator;
  }

  // ── Feed definitions ──────────────────────────────────────────────────

  @Get("feeds")
  @OperatorRoute("feeds:read", "feeds.list")
  listFeeds() {
    return { feeds: this.registry.listFeeds() };
  }

  @Get("feeds/:feedId")
  @OperatorRoute("feeds:read", "feeds.get")
  getFeed(@Param("feedId") feedId: string) {
    return run(() => this.registry.getFeed(feedId));
  }

  @Put("feeds/:feedId")
  @OperatorRoute("feeds:write", "feeds.upsert")
  upsertFeed(@Param("feedId") feedId: string, @Body() body: unknown) {
    const { expectedRevision, ...definition } = (body ?? {}) as Record<string, unknown>;
    const parsedRevision = parse(revision, expectedRevision);
    let feed;
    try {
      [feed] = parseOracleConfig({ version: 1, feeds: [{ ...definition, id: definition.id ?? feedId }] }, "request body").feeds;
    } catch (error) {
      if (error instanceof OracleConfigParseError) {
        throw new BadRequestException({ error: "Invalid feed definition", issues: error.issues });
      }
      throw error;
    }
    return run(() => this.registry.upsertFeed(feedId, feed, parsedRevision));
  }

  @Delete("feeds/:feedId")
  @OperatorRoute("feeds:write", "feeds.delete")
  deleteFeed(@Param("feedId") feedId: string, @Query("expectedRevision") expected?: string) {
    const parsedRevision = expected === undefined ? undefined : parse(revision, Number(expected));
    return run(() => this.registry.deleteFeed(feedId, parsedRevision));
  }

  // ── Quorum policy ─────────────────────────────────────────────────────

  @Put("feeds/:feedId/quorum")
  @OperatorRoute("quorum:write", "quorum.update")
  updateQuorum(@Param("feedId") feedId: string, @Body() body: unknown) {
    const { expectedRevision, ...change } = parse(quorumBody, body ?? {});
    return run(() => this.registry.updateQuorum(feedId, change, expectedRevision));
  }

  // ── Pause / resume ────────────────────────────────────────────────────

  @Post("feeds/:feedId/pause")
  @HttpCode(200)
  @OperatorRoute("feeds:pause", "feeds.pause")
  pause(@Param("feedId") feedId: string, @Body() body: unknown) {
    const { reason: why } = parse(pauseBody, body ?? {});
    return run(() => this.registry.pause(feedId, why));
  }

  @Post("feeds/:feedId/resume")
  @HttpCode(200)
  @OperatorRoute("feeds:pause", "feeds.resume")
  resume(@Param("feedId") feedId: string, @Body() body: unknown) {
    const { reason: why } = parse(resumeBody, body ?? {});
    return run(() => this.registry.resume(feedId, why ?? null));
  }

  // ── Quarantine overrides ──────────────────────────────────────────────

  @Put("feeds/:feedId/sources/:sourceId/quarantine")
  @OperatorRoute("quarantine:override", "quarantine.override")
  overrideQuarantine(
    @Param("feedId") feedId: string,
    @Param("sourceId") sourceId: string,
    @Body() body: unknown
  ) {
    const override = parse(quarantineBody, body ?? {});
    return run(() => this.registry.setQuarantineOverride(feedId, sourceId, override));
  }

  @Delete("feeds/:feedId/sources/:sourceId/quarantine")
  @HttpCode(204)
  @OperatorRoute("quarantine:override", "quarantine.clear")
  clearQuarantine(@Param("feedId") feedId: string, @Param("sourceId") sourceId: string) {
    run(() => this.registry.clearQuarantineOverride(feedId, sourceId));
  }

  // ── Manual overrides ──────────────────────────────────────────────────

  @Put("feeds/:feedId/override")
  @OperatorRoute("manual:override", "manual_override.set")
  setManualOverride(@Param("feedId") feedId: string, @Body() body: unknown) {
    const override = parse(manualOverrideBody, body ?? {});
    return run(() => this.registry.setManualOverride(feedId, override));
  }

  @Delete("feeds/:feedId/override")
  @HttpCode(204)
  @OperatorRoute("manual:override", "manual_override.clear")
  clearManualOverride(@Param("feedId") feedId: string) {
    run(() => this.registry.clearManualOverride(feedId));
  }

  // ── Source bootstrap ──────────────────────────────────────────────────

  @Get("bootstrap")
  @OperatorRoute("feeds:read", "bootstrap.list")
  async listBootstrap(@Query("feedId") feedId?: string) {
    return { records: await this.bootstrap.listRecords(feedId) };
  }

  @Post("feeds/:feedId/sources/:sourceId/bootstrap")
  @HttpCode(200)
  @OperatorRoute("bootstrap:run", "bootstrap.run")
  async runBootstrap(
    @Param("feedId") feedId: string,
    @Param("sourceId") sourceId: string,
    @Body() body: unknown
  ) {
    const { force } = parse(bootstrapBody, body ?? {});
    const source = run(() => this.registry.getFeed(feedId)).definition.sources.find((s) => s.id === sourceId);
    if (!source) throw new NotFoundException({ error: `Feed "${feedId}" has no source "${sourceId}"` });
    return this.bootstrap.bootstrapSource(
      feedId,
      { sourceId, adapter: source.adapter, params: source.params },
      { force, requestedBy: currentActor() }
    );
  }

  // ── Audit trail ───────────────────────────────────────────────────────

  @Get("audit")
  @OperatorRoute("audit:read", "audit.list")
  listAudit(@Query("limit") limit?: string) {
    const parsed = Math.min(1_000, Math.max(1, Number(limit ?? 100) || 100));
    return { events: this.audit.list(parsed) };
  }
}
