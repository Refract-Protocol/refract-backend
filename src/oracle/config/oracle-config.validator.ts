import { CoverageTypeName } from "../../common/coverage-type.map";
import {
  KNOWN_ADAPTERS,
  OracleConfigFile,
  ResolvedFeed,
  TRUST_MODES,
  TrustMode,
  resolveFeeds,
} from "./oracle-feed-config";

export type IssueSeverity = "error" | "warning";

export interface OracleConfigIssue {
  severity: IssueSeverity;
  code: string;
  /** Feed id, or `feeds[i]` when the id is the problem, or `(config)`. */
  feed: string;
  message: string;
}

export interface OracleConfigReport {
  feedCount: number;
  errors: OracleConfigIssue[];
  warnings: OracleConfigIssue[];
}

export interface ValidationContext {
  network: string;
  /** Adapter names this build can poll. */
  knownAdapters?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

/** Below this, upstream API rate limits are at risk and scheduler jitter dominates. */
export const MIN_POLL_INTERVAL_MS = 1_000;

/** Distinct operators among enabled sources; same-operator sources are one source for quorum. */
export function independentSourceCount(feed: ResolvedFeed): number {
  return new Set(feed.sources.filter((s) => s.enabled).map((s) => s.operator)).size;
}

/**
 * Rejects oracle feed and quorum configurations that cannot work or are
 * unsafe, so they fail at startup or in CI instead of degrading silently at
 * runtime. Errors block startup; warnings are logged (and block startup in
 * strict mode).
 */
export function validateOracleConfig(
  config: OracleConfigFile,
  context: ValidationContext
): OracleConfigReport {
  const issues: OracleConfigIssue[] = [];
  const add = (severity: IssueSeverity, code: string, feed: string, message: string) =>
    issues.push({ severity, code, feed, message });

  const knownAdapters = new Set(context.knownAdapters ?? KNOWN_ADAPTERS);
  const coverageTypes = new Set<string>(Object.values(CoverageTypeName));
  const mainnet = context.network.trim().toLowerCase() === "mainnet";
  const feeds = resolveFeeds(config, context.env ?? {});

  if (feeds.length === 0) {
    add("error", "NO_FEEDS", "(config)", "No oracle feeds are configured");
  }

  const seenFeedIds = new Set<string>();
  feeds.forEach((feed, index) => {
    const label = feed.id || `feeds[${index}]`;
    if (seenFeedIds.has(feed.id)) {
      add("error", "DUPLICATE_FEED_ID", label, `Feed id "${feed.id}" is defined more than once`);
    }
    seenFeedIds.add(feed.id);

    if (!coverageTypes.has(feed.coverageType)) {
      add(
        "error",
        "UNKNOWN_COVERAGE_TYPE",
        label,
        `coverageType "${feed.coverageType}" is not one of ${[...coverageTypes].join(", ")}`
      );
    }

    // ── Trust mode ────────────────────────────────────────────────────────
    let trustMode: TrustMode | undefined;
    if (feed.trustMode === undefined || feed.trustMode === "") {
      add(
        "error",
        "MISSING_TRUST_MODE",
        label,
        `No trustMode set on the feed or in defaults; choose one of ${TRUST_MODES.join(", ")}`
      );
    } else if (!(TRUST_MODES as readonly string[]).includes(feed.trustMode)) {
      add(
        "error",
        "UNKNOWN_TRUST_MODE",
        label,
        `trustMode "${feed.trustMode}" is not one of ${TRUST_MODES.join(", ")}`
      );
    } else {
      trustMode = feed.trustMode as TrustMode;
    }

    // ── Sources ───────────────────────────────────────────────────────────
    const seenSourceIds = new Set<string>();
    for (const source of feed.sources) {
      if (seenSourceIds.has(source.id)) {
        add("error", "DUPLICATE_SOURCE_ID", label, `Source id "${source.id}" appears more than once`);
      }
      seenSourceIds.add(source.id);

      if (!knownAdapters.has(source.adapter)) {
        add(
          "error",
          "UNKNOWN_ADAPTER",
          label,
          `Source "${source.id}" uses adapter "${source.adapter}", which this build cannot poll (known: ${[...knownAdapters].join(", ")})`
        );
      }
      if (source.enabled && source.adapter === "mock" && mainnet && feed.settlesClaims) {
        add(
          "error",
          "MOCK_SOURCE_ON_MAINNET",
          label,
          `Source "${source.id}" returns synthetic data and cannot settle claims on mainnet`
        );
      }
    }

    const enabled = feed.sources.filter((s) => s.enabled);
    const independent = independentSourceCount(feed);
    if (enabled.length === 0) {
      add("error", "NO_ENABLED_SOURCES", label, "Feed has no enabled sources");
    }

    const operators = new Map<string, string[]>();
    for (const source of enabled) {
      operators.set(source.operator, [...(operators.get(source.operator) ?? []), source.id]);
    }
    for (const [operator, ids] of operators) {
      if (ids.length > 1) {
        add(
          "warning",
          "SHARED_OPERATOR",
          label,
          `Sources ${ids.join(", ")} share operator "${operator}" and count as one independent source`
        );
      }
    }

    // ── Quorum ────────────────────────────────────────────────────────────
    if (feed.minSources < 1) {
      add("error", "QUORUM_TOO_SMALL", label, `quorum.minSources must be at least 1 (got ${feed.minSources})`);
    } else if (feed.minSources > independent && enabled.length > 0) {
      add(
        "error",
        "QUORUM_EXCEEDS_INDEPENDENT_SOURCES",
        label,
        `quorum.minSources is ${feed.minSources} but only ${independent} independent source(s) are enabled, so quorum can never be reached`
      );
    } else if (feed.minSources > 1 && feed.minSources === independent) {
      add(
        "warning",
        "NO_QUORUM_HEADROOM",
        label,
        `quorum.minSources equals the ${independent} independent sources; one source outage stalls the feed`
      );
    }

    if (feed.maxDeviationBps <= 0 || feed.maxDeviationBps > 10_000) {
      add(
        "error",
        "DEVIATION_OUT_OF_RANGE",
        label,
        `quorum.maxDeviationBps must be between 1 and 10000 (got ${feed.maxDeviationBps})`
      );
    }

    if (trustMode === "single_source") {
      if (feed.minSources > 1) {
        add(
          "error",
          "TRUST_MODE_QUORUM_CONFLICT",
          label,
          `trustMode single_source cannot satisfy quorum.minSources ${feed.minSources}`
        );
      }
      if (mainnet && feed.settlesClaims) {
        add(
          "error",
          "SINGLE_SOURCE_ON_MAINNET",
          label,
          "A single-source feed cannot settle claims on mainnet; use median_quorum or weighted_quorum with at least 2 independent sources"
        );
      } else if (feed.settlesClaims) {
        add("warning", "SINGLE_SOURCE", label, "Feed trusts one source with no corroboration");
      }
      if (enabled.length > 1) {
        add(
          "warning",
          "UNUSED_SOURCES",
          label,
          `trustMode single_source uses only the first of ${enabled.length} enabled sources`
        );
      }
    }

    if (trustMode === "median_quorum" || trustMode === "weighted_quorum") {
      if (feed.minSources < 2) {
        add(
          "error",
          "QUORUM_MODE_WITHOUT_QUORUM",
          label,
          `trustMode ${trustMode} needs quorum.minSources of at least 2 (got ${feed.minSources})`
        );
      } else if (feed.minSources * 2 <= independent) {
        add(
          "warning",
          "MINORITY_QUORUM",
          label,
          `quorum.minSources ${feed.minSources} is not a majority of ${independent} independent sources; two disjoint groups could each reach quorum`
        );
      }
    }

    if (trustMode === "weighted_quorum") {
      const weights = enabled.map((s) => s.weight);
      if (weights.some((w) => w === undefined || !(w > 0))) {
        add(
          "error",
          "MISSING_SOURCE_WEIGHT",
          label,
          "trustMode weighted_quorum needs a positive weight on every enabled source"
        );
      } else {
        const total = weights.reduce((sum: number, w) => sum + (w as number), 0);
        const byOperator = new Map<string, number>();
        for (const source of enabled) {
          byOperator.set(source.operator, (byOperator.get(source.operator) ?? 0) + (source.weight as number));
        }
        for (const [operator, weight] of byOperator) {
          if (weight / total > 0.5) {
            add(
              "error",
              "OPERATOR_CONTROLS_QUORUM",
              label,
              `Operator "${operator}" holds ${Math.round((weight / total) * 100)}% of the weight and can decide the reading alone`
            );
          }
        }
      }
    }

    // ── Timing ────────────────────────────────────────────────────────────
    if (feed.pollIntervalMs < MIN_POLL_INTERVAL_MS) {
      add(
        "error",
        "POLL_INTERVAL_TOO_SHORT",
        label,
        `pollIntervalMs must be at least ${MIN_POLL_INTERVAL_MS} (got ${feed.pollIntervalMs})`
      );
    }
    if (feed.freshnessWindowMs < feed.pollIntervalMs) {
      add(
        "error",
        "FRESHNESS_SHORTER_THAN_POLL",
        label,
        `freshnessWindowMs (${feed.freshnessWindowMs}) is shorter than pollIntervalMs (${feed.pollIntervalMs}); every reading would be stale before the next poll`
      );
    } else if (feed.freshnessWindowMs < feed.pollIntervalMs * 2) {
      add(
        "warning",
        "FRESHNESS_WINDOW_TIGHT",
        label,
        `freshnessWindowMs (${feed.freshnessWindowMs}) is under two poll intervals; one slow or missed poll makes the feed stale`
      );
    }
    if (feed.publishMinIntervalMs < 0) {
      add("error", "PUBLISH_INTERVAL_NEGATIVE", label, "publish.minIntervalMs cannot be negative");
    } else if (feed.publishMinIntervalMs > feed.freshnessWindowMs && feed.publishMode === "on_change") {
      add(
        "warning",
        "PUBLISH_INTERVAL_EXCEEDS_FRESHNESS",
        label,
        `publish.minIntervalMs (${feed.publishMinIntervalMs}) exceeds freshnessWindowMs (${feed.freshnessWindowMs}); the on-chain reading can age past the freshness window between publishes`
      );
    }
  });

  return {
    feedCount: feeds.length,
    errors: issues.filter((i) => i.severity === "error"),
    warnings: issues.filter((i) => i.severity === "warning"),
  };
}

export function formatReport(report: OracleConfigReport, origin: string): string {
  const lines = [
    `Oracle feed config (${origin}): ${report.feedCount} feed(s), ${report.errors.length} error(s), ${report.warnings.length} warning(s)`,
  ];
  for (const issue of [...report.errors, ...report.warnings]) {
    lines.push(`  ${issue.severity.toUpperCase()} ${issue.code} [${issue.feed}] ${issue.message}`);
  }
  return lines.join("\n");
}
