import { z } from "zod";

/** Bumped whenever a response shape changes incompatibly. */
export const ORACLE_STATUS_API_VERSION = "v1";

export const FEED_KEYS = [
  "stablecoin_depeg",
  "market_crash",
  "liquidation_shield",
  "smart_contract_risk",
  "flight_delay",
] as const;

export const feedKeySchema = z.enum(FEED_KEYS);

/**
 * live     – fresh value with quorum; authoritative.
 * degraded – still settled on a recent value, but quorum is not met; authoritative
 *            but consumers should surface a warning.
 * paused   – value is stale; NO authoritative value exists and settlement is paused.
 * unknown  – no decision has been recorded for the feed yet.
 */
export const freshnessStateSchema = z.enum(["live", "degraded", "paused", "unknown"]);
export const trustModeSchema = z.enum(["multi_source", "single_source", "none"]);
export const sourceHealthSchema = z.enum(["healthy", "stale", "down"]);

export const sourceStatusSchema = z
  .object({
    name: z.string(),
    health: sourceHealthSchema,
    lastSeenAt: z.string().datetime(),
    readings24h: z.number().int().nonnegative(),
    reputation: z.number().min(0).max(1),
  })
  .strict();

export const quorumSchema = z
  .object({
    required: z.number().int().positive(),
    achieved: z.number().int().nonnegative(),
    met: z.boolean(),
    windowSeconds: z.number().int().positive(),
  })
  .strict();

export const decisionSchema = z
  .object({
    /** Opaque reference into the evidence ledger; never raw contents. */
    evidenceRef: z.string(),
    value: z.number(),
    severity: z.string(),
    method: z.enum(["multi_source_median", "single_source"]),
    quorum: quorumSchema,
    divergenceBps: z.number().nonnegative(),
    decidedAt: z.string().datetime(),
  })
  .strict();

export const feedSummarySchema = z
  .object({
    feedKey: feedKeySchema,
    state: freshnessStateSchema,
    /** True only when `state` is live or degraded. */
    authoritative: z.boolean(),
    trustMode: trustModeSchema,
    health: sourceHealthSchema.nullable(),
    lastDecision: decisionSchema.nullable(),
  })
  .strict();

export const feedListResponseSchema = z
  .object({ apiVersion: z.literal(ORACLE_STATUS_API_VERSION), feeds: z.array(feedSummarySchema) })
  .strict();

export const feedDetailResponseSchema = z
  .object({
    apiVersion: z.literal(ORACLE_STATUS_API_VERSION),
    feed: feedSummarySchema
      .extend({
        /** Null unless the feed is authoritative; a paused feed never exposes a "latest" value. */
        latestValue: z.number().nullable(),
        /** Last value seen before the feed paused; informational only, not settleable. */
        lastKnownValue: z.number().nullable(),
        sources: z.array(sourceStatusSchema),
        evidenceUrl: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export const feedHistoryResponseSchema = z
  .object({
    apiVersion: z.literal(ORACLE_STATUS_API_VERSION),
    feedKey: feedKeySchema,
    items: z.array(decisionSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type FeedSummary = z.infer<typeof feedSummarySchema>;
export type FeedDetailResponse = z.infer<typeof feedDetailResponseSchema>;
export type FeedListResponse = z.infer<typeof feedListResponseSchema>;
export type FeedHistoryResponse = z.infer<typeof feedHistoryResponseSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export type SourceStatus = z.infer<typeof sourceStatusSchema>;
