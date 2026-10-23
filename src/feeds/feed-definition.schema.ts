import { z } from "zod";
import { COVERAGE_CATALOG, CoverageType } from "../common/coverage-catalog";

const COVERAGE_TYPES = Object.keys(COVERAGE_CATALOG) as [CoverageType, ...CoverageType[]];

export const FEED_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** Max freshness window: one day. Longer windows would let stale readings settle claims. */
const MAX_FRESHNESS_WINDOW_SECONDS = 86_400;

export const feedSourceSchema = z.object({
  sourceId: z.string().trim().min(1).max(64),
  weight: z.number().int().min(1).max(100),
  /** Quarantined sources stay in the roster for audit but do not count toward quorum. */
  quarantined: z.boolean().default(false),
});

const feedFieldsSchema = z.object({
  coverageType: z.enum(COVERAGE_TYPES),
  sources: z.array(feedSourceSchema).min(1).max(20),
  /** Minimum summed weight of agreeing, non-quarantined sources. */
  quorumThreshold: z.number().int().min(1),
  freshnessWindowSeconds: z.number().int().min(1).max(MAX_FRESHNESS_WINDOW_SECONDS),
  trustMode: z.enum(["single_source", "corroborated"]),
  enabled: z.boolean(),
});

/**
 * Cross-field rules. A disabled feed may be stored in any shape. An enabled feed
 * must be able to reach its own quorum, otherwise it would never settle a claim.
 */
function checkFeasibility(
  feed: z.infer<typeof feedFieldsSchema>,
  ctx: z.RefinementCtx,
): void {
  const sourceIds = feed.sources.map((source) => source.sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) {
    ctx.addIssue({ code: "custom", path: ["sources"], message: "sourceId must be unique within a feed" });
  }

  if (!feed.enabled) return;

  const active = feed.sources.filter((source) => !source.quarantined);
  const activeWeight = active.reduce((sum, source) => sum + source.weight, 0);
  const minActiveSources = feed.trustMode === "corroborated" ? 2 : 1;

  if (active.length < minActiveSources) {
    ctx.addIssue({
      code: "custom",
      path: ["sources"],
      message: `enabled ${feed.trustMode} feed needs at least ${minActiveSources} non-quarantined source(s), has ${active.length}`,
    });
  }
  if (activeWeight < feed.quorumThreshold) {
    ctx.addIssue({
      code: "custom",
      path: ["quorumThreshold"],
      message: `enabled feed can never reach quorum: active weight ${activeWeight} < quorumThreshold ${feed.quorumThreshold}`,
    });
  }
}

export const feedDefinitionSchema = feedFieldsSchema.superRefine(checkFeasibility);

export const createFeedSchema = feedFieldsSchema
  .extend({ feedKey: z.string().regex(FEED_KEY_PATTERN, "feedKey must be 2-64 lowercase alphanumeric or '-' characters") })
  .superRefine(checkFeasibility);

/** Partial update. Feasibility is re-checked against the merged definition in the service. */
export const updateFeedSchema = feedFieldsSchema.partial().extend({
  expectedVersion: z.number().int().min(1),
});

export type FeedSource = z.infer<typeof feedSourceSchema>;
export type FeedDefinition = z.infer<typeof feedDefinitionSchema>;
export type CreateFeedInput = z.infer<typeof createFeedSchema>;
export type UpdateFeedInput = z.infer<typeof updateFeedSchema>;
