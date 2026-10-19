import { BadRequestException, Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import { OpsAuthGuard } from "../common/guards/ops-auth.guard";
import { OracleControlService, PAUSE_SCOPES } from "./control";

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

@ApiExcludeController()
@Controller("api/v1/oracle")
@UseGuards(OpsAuthGuard)
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class OracleController {
  constructor(private readonly oracleControl: OracleControlService) {}

  @Get("status")
  status() {
    return this.oracleControl.getStatus();
  }

  @Post("pause")
  pause(@Body() body: unknown) {
    const { scope, actor, reason } = parsePauseRequest(body);
    return this.oracleControl.setPaused(scope, true, actor, reason);
  }

  @Post("resume")
  resume(@Body() body: unknown) {
    const { scope, actor, reason } = parsePauseRequest(body);
    return this.oracleControl.setPaused(scope, false, actor, reason);
  }
}
