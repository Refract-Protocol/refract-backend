import { BadRequestException, Body, Controller, Get, Header, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiExcludeController, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { OpsAuthGuard } from "../common/guards/ops-auth.guard";
import { OracleControlService, PAUSE_SCOPES } from "./control";
import { OracleStatusService } from "./oracle-status.service";
import { PageQueryDto } from "../common/pagination";
import { FEED_KEYS } from "../common/oracle-status.schemas";

const CACHE_CONTROL = "public, max-age=15";

/**
 * `actor` is self-declared: the ops bearer token identifies the caller as an
 * operator but not which person, so the operator names themselves for the audit trail.
 */
const pauseRequestSchema = z
  .object({
    scope: z.enum(PAUSE_SCOPES),
    actor: z.string().trim().min(1).max(128),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

function parsePauseRequest(body: unknown): z.infer<typeof pauseRequestSchema> {
  const parsed = pauseRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException({
      code: "VALIDATION_FAILED",
      error: "Invalid oracle control request.",
      details: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

const decisionDoc = {
  type: "object",
  properties: {
    evidenceRef: { type: "string", example: "oracle_events:1042" },
    value: { type: "number", example: 0.9985 },
    severity: { type: "string", example: "low" },
    method: { type: "string", enum: ["multi_source_median", "single_source"] },
    quorum: {
      type: "object",
      properties: {
        required: { type: "integer", example: 2 },
        achieved: { type: "integer", example: 2 },
        met: { type: "boolean" },
        windowSeconds: { type: "integer", example: 120 },
      },
    },
    divergenceBps: { type: "number", example: 12 },
    decidedAt: { type: "string", format: "date-time" },
  },
};

const summaryProps = {
  feedKey: { type: "string", enum: [...FEED_KEYS] },
  state: {
    type: "string",
    enum: ["live", "degraded", "paused", "unknown"],
    description: "degraded = recent value still settled without quorum; paused = stale, no authoritative value.",
  },
  authoritative: { type: "boolean", description: "False for paused/unknown: no settleable value exists." },
  trustMode: { type: "string", enum: ["multi_source", "single_source", "none"] },
  health: { type: "string", enum: ["healthy", "stale", "down"], nullable: true },
  lastDecision: { ...decisionDoc, nullable: true },
};

/**
 * Public, read-only oracle trust status. Exposes no keys, operator metadata or
 * raw provider payloads; evidence is referenced by id only.
 */
@ApiTags("oracle")
@Controller("api/v1/oracle")
export class OracleController {
  constructor(
    private readonly status: OracleStatusService,
    private readonly oracleControl: OracleControlService,
  ) {}

  @Get("feeds")
  @Header("Cache-Control", CACHE_CONTROL)
  @ApiOperation({ summary: "List all oracle feeds with trust mode, freshness state and last decision" })
  @ApiOkResponse({
    schema: {
      type: "object",
      properties: {
        apiVersion: { type: "string", example: "v1" },
        feeds: { type: "array", items: { type: "object", properties: summaryProps } },
      },
    },
  })
  listFeeds() {
    return this.status.listFeeds();
  }

  @Get("feeds/:feedKey")
  @Header("Cache-Control", CACHE_CONTROL)
  @ApiOperation({ summary: "Feed detail: sources, latest corroborated value, quorum and evidence reference" })
  @ApiParam({ name: "feedKey", enum: [...FEED_KEYS] })
  @ApiOkResponse({
    schema: {
      type: "object",
      properties: {
        apiVersion: { type: "string", example: "v1" },
        feed: {
          type: "object",
          properties: {
            ...summaryProps,
            latestValue: { type: "number", nullable: true, description: "Null unless the feed is authoritative." },
            lastKnownValue: {
              type: "number",
              nullable: true,
              description: "Stale value of a paused feed; informational, not settleable.",
            },
            sources: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  health: { type: "string", enum: ["healthy", "stale", "down"] },
                  lastSeenAt: { type: "string", format: "date-time" },
                  readings24h: { type: "integer" },
                  reputation: { type: "number", minimum: 0, maximum: 1 },
                },
              },
            },
            evidenceUrl: { type: "string", nullable: true },
          },
        },
      },
    },
  })
  @ApiNotFoundResponse({ description: "Unknown feed key" })
  getFeed(@Param("feedKey") feedKey: string) {
    return this.status.getFeed(feedKey);
  }

  @Get("feeds/:feedKey/history")
  @Header("Cache-Control", CACHE_CONTROL)
  @ApiOperation({ summary: "Paginated recent decisions with method and quorum metadata (newest first)" })
  @ApiParam({ name: "feedKey", enum: [...FEED_KEYS] })
  @ApiQuery({ name: "limit", required: false, type: Number, description: "1-100, default 20" })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiOkResponse({
    schema: {
      type: "object",
      properties: {
        apiVersion: { type: "string", example: "v1" },
        feedKey: { type: "string", enum: [...FEED_KEYS] },
        items: { type: "array", items: decisionDoc },
        nextCursor: { type: "string", nullable: true },
      },
    },
  })
  @ApiNotFoundResponse({ description: "Unknown feed key" })
  getHistory(@Param("feedKey") feedKey: string, @Query() query: PageQueryDto) {
    return this.status.getHistory(feedKey, query.limit, query.cursor);
  }

  @Get("status")
  @UseGuards(OpsAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  status() {
    return this.oracleControl.getStatus();
  }

  @Post("pause")
  @UseGuards(OpsAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  pause(@Body() body: unknown) {
    const { scope, actor, reason } = parsePauseRequest(body);
    return this.oracleControl.setPaused(scope, true, actor, reason);
  }

  @Post("resume")
  @UseGuards(OpsAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  resume(@Body() body: unknown) {
    const { scope, actor, reason } = parsePauseRequest(body);
    return this.oracleControl.setPaused(scope, false, actor, reason);
  }
}
