import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { ZodType } from "zod";
import { AdminApiKeyGuard, AdminOnly } from "../common/admin-auth";
import { FeedDefinitionsService } from "./feed-definitions.service";
import { createFeedSchema, updateFeedSchema } from "./feed-definition.schema";

/**
 * Admin-only feed definition API. Every route requires the admin API key.
 * Mutations also require `x-admin-actor`, which is recorded in the audit trail.
 * The shared admin key does not identify the operator, so the actor is
 * self-reported until per-operator credentials exist.
 */
@Controller("api/v1/admin/feeds")
@AdminOnly()
@UseGuards(AdminApiKeyGuard)
export class FeedsController {
  constructor(private readonly feeds: FeedDefinitionsService) {}

  @Get()
  async list() {
    return { feeds: await this.feeds.listLatest() };
  }

  @Get(":feedKey")
  async getOne(@Param("feedKey") feedKey: string) {
    return { feed: await this.feeds.getLatest(feedKey) };
  }

  @Get(":feedKey/versions")
  async versions(@Param("feedKey") feedKey: string) {
    return { versions: await this.feeds.listVersions(feedKey) };
  }

  @Post()
  async create(@Body() body: unknown, @Headers("x-admin-actor") actor: string | undefined) {
    const input = parseOrThrow(createFeedSchema, body);
    return { feed: await this.feeds.create(input, requireActor(actor)) };
  }

  @Patch(":feedKey")
  async update(
    @Param("feedKey") feedKey: string,
    @Body() body: unknown,
    @Headers("x-admin-actor") actor: string | undefined,
  ) {
    const input = parseOrThrow(updateFeedSchema, body);
    return { feed: await this.feeds.update(feedKey, input, requireActor(actor)) };
  }
}

function requireActor(actor: string | undefined): string {
  const trimmed = actor?.trim();
  if (!trimmed || trimmed.length > 128) {
    throw new BadRequestException({
      code: "ADMIN_ACTOR_REQUIRED",
      error: "The x-admin-actor header is required and must be 1-128 characters.",
    });
  }
  return trimmed;
}

function parseOrThrow<T>(schema: ZodType<T, any, any>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException({
      code: "FEED_INVALID",
      error: "Feed definition is invalid.",
      issues: result.error.issues,
    });
  }
  return result.data;
}
