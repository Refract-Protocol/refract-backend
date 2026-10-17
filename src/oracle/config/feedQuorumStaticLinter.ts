export interface LintableSourceConfig {
  sourceId: string;
  upstreamOrigin: string;
  enabled: boolean;
  apiKey?: string;
  hmacSecret?: string;
}

export interface LintableFeedConfig {
  feedId: string;
  enabled: boolean;
  trustMode: "single_source" | "corroborated" | "decentralized";
  quorumMinimum: number;
  pollIntervalMs: number;
  expectedMinAttemptsInWindow?: number;
  freshnessWindowMs: number;
  maxDivergenceRatio: number;
  sources: LintableSourceConfig[];
}

export interface ConfigLintViolation {
  feedId: string;
  fieldPath: string;
  ruleId:
    | "DUPLICATE_SOURCE_ID"
    | "QUORUM_EXCEEDS_INDEPENDENT_ORIGINS"
    | "FRESHNESS_WINDOW_TOO_SHORT"
    | "TRUST_MODE_INCOMPATIBLE"
    | "ANOMALY_THRESHOLD_OUT_OF_RANGE";
  message: string;
}

export class OracleFeedConfigStaticLinter {
  public static lintConfiguration(feeds: LintableFeedConfig[]): {
    valid: boolean;
    violations: ConfigLintViolation[];
  } {
    const violations: ConfigLintViolation[] = [];

    for (const feed of feeds) {
      // 1. Check duplicate sourceId regardless of enabled state
      const seenSourceIds = new Set<string>();
      for (let i = 0; i < feed.sources.length; i++) {
        const src = feed.sources[i]!;
        if (seenSourceIds.has(src.sourceId)) {
          violations.push({
            feedId: feed.feedId,
            fieldPath: `feeds[${feed.feedId}].sources[${i}].sourceId`,
            ruleId: "DUPLICATE_SOURCE_ID",
            message: `Duplicate sourceId "${src.sourceId}" in feed "${feed.feedId}"`,
          });
        }
        seenSourceIds.add(src.sourceId);
      }

      // Intentionally disabled feeds do not fail startup on active-source/quorum rules
      if (!feed.enabled) {
        continue;
      }

      // 2. Anomaly threshold within (0, 0.50]
      if (
        !Number.isFinite(feed.maxDivergenceRatio) ||
        feed.maxDivergenceRatio <= 0 ||
        feed.maxDivergenceRatio > 0.5
      ) {
        violations.push({
          feedId: feed.feedId,
          fieldPath: `feeds[${feed.feedId}].maxDivergenceRatio`,
          ruleId: "ANOMALY_THRESHOLD_OUT_OF_RANGE",
          message: `maxDivergenceRatio (${feed.maxDivergenceRatio}) must be within (0, 0.50]`,
        });
      }

      // 3. Freshness window >= pollIntervalMs * expectedMinAttemptsInWindow
      const minAttempts = feed.expectedMinAttemptsInWindow ?? 2;
      const minFreshnessMs = feed.pollIntervalMs * minAttempts;
      if (
        feed.pollIntervalMs <= 0 ||
        feed.freshnessWindowMs < minFreshnessMs
      ) {
        violations.push({
          feedId: feed.feedId,
          fieldPath: `feeds[${feed.feedId}].freshnessWindowMs`,
          ruleId: "FRESHNESS_WINDOW_TOO_SHORT",
          message: `freshnessWindowMs (${feed.freshnessWindowMs}ms) must be >= pollIntervalMs * ${minAttempts} (${minFreshnessMs}ms)`,
        });
      }

      // 4. Trust mode compatibility with quorumMinimum
      if (
        (feed.trustMode === "corroborated" ||
          feed.trustMode === "decentralized") &&
        feed.quorumMinimum < 2
      ) {
        violations.push({
          feedId: feed.feedId,
          fieldPath: `feeds[${feed.feedId}].quorumMinimum`,
          ruleId: "TRUST_MODE_INCOMPATIBLE",
          message: `Trust mode "${feed.trustMode}" requires quorumMinimum >= 2, got ${feed.quorumMinimum}`,
        });
      }

      // 5. Quorum <= eligible distinct independent upstreamOrigins
      const activeSources = feed.sources.filter((s) => s.enabled);
      const distinctOrigins = new Set(
        activeSources.map((s) => s.upstreamOrigin)
      );
      if (feed.quorumMinimum > distinctOrigins.size) {
        violations.push({
          feedId: feed.feedId,
          fieldPath: `feeds[${feed.feedId}].sources`,
          ruleId: "QUORUM_EXCEEDS_INDEPENDENT_ORIGINS",
          message: `quorumMinimum (${feed.quorumMinimum}) exceeds distinct enabled upstream origins (${distinctOrigins.size})`,
        });
      }
    }

    return {
      valid: violations.length === 0,
      violations,
    };
  }

  public static validateOrThrowStartup(feeds: LintableFeedConfig[]): void {
    const res = this.lintConfiguration(feeds);
    if (!res.valid) {
      const details = res.violations
        .map((v) => `[${v.ruleId}] ${v.fieldPath}: ${v.message}`)
        .join("; ");
      throw new Error(`ORACLE_CONFIG_LINT_FAILED: ${details}`);
    }
  }

  public static renderRedactedEffectiveConfigJson(
    feeds: LintableFeedConfig[]
  ): string {
    const sortedFeeds = [...feeds]
      .sort((a, b) => a.feedId.localeCompare(b.feedId))
      .map((f) => ({
        feedId: f.feedId,
        enabled: f.enabled,
        trustMode: f.trustMode,
        quorumMinimum: f.quorumMinimum,
        pollIntervalMs: f.pollIntervalMs,
        freshnessWindowMs: f.freshnessWindowMs,
        maxDivergenceRatio: f.maxDivergenceRatio,
        sources: [...f.sources]
          .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
          .map((s) => ({
            sourceId: s.sourceId,
            upstreamOrigin: s.upstreamOrigin,
            enabled: s.enabled,
            apiKey: s.apiKey ? "[REDACTED]" : undefined,
            hmacSecret: s.hmacSecret ? "[REDACTED]" : undefined,
          })),
      }));

    return JSON.stringify(sortedFeeds, null, 2);
  }
}
