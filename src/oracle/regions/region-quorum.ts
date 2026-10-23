/**
 * Cross-region agreement for oracle readings.
 *
 * Each region runs its own poller and reports what it saw for every feed,
 * including failures. A feed's value is only trusted when enough regions
 * agree on it AND those regions don't all depend on the same CDN, DNS
 * provider, network (ASN) or cloud. Without that second rule, three regions
 * behind the same CDN edge serving a cached (stale or poisoned) response
 * would look like independent confirmation.
 *
 * evaluateRegionalQuorum() is pure and deterministic: same observations,
 * profiles, config and `now` give the same verdict.
 */

/** Shared infrastructure a regional poller depends on. Each value names one failure domain. */
export interface RegionProfile {
  region: string;
  cdn?: string;
  dnsProvider?: string;
  asn?: string;
  cloudProvider?: string;
}

export const FAILURE_DOMAIN_DIMENSIONS = ["cdn", "dnsProvider", "asn", "cloudProvider"] as const;
export type FailureDomainDimension = (typeof FAILURE_DOMAIN_DIMENSIONS)[number];

export type FetchErrorKind = "timeout" | "dns" | "tls" | "connection" | "http_4xx" | "http_5xx" | "invalid_response";

export type RegionalOutcome =
  | {
      kind: "ok";
      value: number;
      /** Timestamp the upstream API put on the value, if it gives one (epoch ms). */
      upstreamTimestamp?: number;
    }
  | { kind: "error"; error: FetchErrorKind; detail?: string };

export interface RegionalObservation {
  region: string;
  feedId: string;
  /** When the regional poller made the request, epoch ms. */
  observedAt: number;
  outcome: RegionalOutcome;
}

export type FeedTrustState =
  /** Enough independent regions agree. */
  | "trusted"
  /** Not enough independent agreeing regions, and no sign of a systemic failure. */
  | "under_corroborated"
  /** Regions returned values but no majority agrees. */
  | "disputed"
  /** A correlated failure is affecting the feed. */
  | "degraded";

export interface CorrelatedFailure {
  /** Which shared dependency the failing regions have in common. */
  dimension: FailureDomainDimension | "error_kind" | "widespread" | "stale_upstream";
  /** The shared value: a CDN name, an error kind, "<down>/<total>", or the frozen upstream timestamp. */
  value: string;
  regions: string[];
  errorKinds: FetchErrorKind[];
}

export interface QuorumConfig {
  /** Minimum agreeing regions for "trusted". */
  minAgreeingRegions: number;
  /** For each listed dimension, the agreeing regions must span at least this many distinct values. */
  minDistinctFailureDomains: number;
  requireDistinct: readonly FailureDomainDimension[];
  /** Agreement tolerance relative to the median, in basis points. */
  toleranceBps: number;
  /** Agreement tolerance floor, in reading units (for values near zero). */
  absoluteTolerance: number;
  /** Ignore observations older than this, ms. */
  maxObservationAgeMs: number;
  /** Regions failing together that share a dependency: at least this many… */
  correlatedMinRegions: number;
  /** …and at least this fraction of all regions sharing that dependency value. */
  correlatedMinFraction: number;
  /** If every agreeing region reports the same upstream timestamp older than this, the upstream is treated as frozen. */
  maxUpstreamAgeMs: number;
}

export const DEFAULT_QUORUM_CONFIG: QuorumConfig = {
  minAgreeingRegions: 2,
  minDistinctFailureDomains: 2,
  requireDistinct: ["cdn", "dnsProvider", "asn"],
  toleranceBps: 50,
  absoluteTolerance: 1e-9,
  maxObservationAgeMs: 2 * 60_000,
  correlatedMinRegions: 2,
  correlatedMinFraction: 0.75,
  maxUpstreamAgeMs: 10 * 60_000,
};

export interface QuorumVerdict {
  feedId: string;
  trust: FeedTrustState;
  /** Median of the agreeing values; set only when trust is "trusted". */
  value: number | null;
  agreeingRegions: string[];
  dissentingRegions: string[];
  failingRegions: string[];
  missingRegions: string[];
  correlatedFailures: CorrelatedFailure[];
  reasons: string[];
  evaluatedAt: number;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Unknown attributes all count as one shared "unknown" domain, never as independent. */
function domainOf(profile: RegionProfile | undefined, dim: FailureDomainDimension): string {
  return profile?.[dim] ?? "unknown";
}

export function evaluateRegionalQuorum(
  feedId: string,
  observations: readonly RegionalObservation[],
  profiles: readonly RegionProfile[],
  config: QuorumConfig,
  now: number,
): QuorumVerdict {
  const profileByRegion = new Map(profiles.map((p) => [p.region, p]));
  const reasons: string[] = [];

  // Latest fresh observation per known region. Reports from unregistered regions are ignored.
  const latest = new Map<string, RegionalObservation>();
  for (const o of observations) {
    if (o.feedId !== feedId || !profileByRegion.has(o.region)) continue;
    if (now - o.observedAt > config.maxObservationAgeMs || o.observedAt > now + 30_000) continue;
    const prev = latest.get(o.region);
    if (!prev || o.observedAt > prev.observedAt) latest.set(o.region, o);
  }

  const regions = [...profileByRegion.keys()].sort();
  const missingRegions = regions.filter((r) => !latest.has(r));
  const ok = [...latest.values()].filter((o): o is RegionalObservation & { outcome: { kind: "ok" } } => o.outcome.kind === "ok" && Number.isFinite(o.outcome.value));
  const failingRegions = [...latest.values()].filter((o) => o.outcome.kind === "error" || !Number.isFinite((o.outcome as { value?: number }).value)).map((o) => o.region).sort();

  // Agreement around the median of all ok values.
  let agreeing: typeof ok = [];
  let dissenting: typeof ok = [];
  if (ok.length > 0) {
    const m = median(ok.map((o) => o.outcome.value));
    const tol = Math.max(config.absoluteTolerance, (Math.abs(m) * config.toleranceBps) / 10_000);
    agreeing = ok.filter((o) => Math.abs(o.outcome.value - m) <= tol);
    dissenting = ok.filter((o) => Math.abs(o.outcome.value - m) > tol);
  }
  const agreeingRegions = agreeing.map((o) => o.region).sort();
  const dissentingRegions = dissenting.map((o) => o.region).sort();

  const correlatedFailures = detectCorrelatedFailures(latest, missingRegions, profiles, agreeing, config, now);

  // Decide trust.
  let trust: FeedTrustState = "trusted";
  if (agreeingRegions.length < config.minAgreeingRegions) {
    trust = "under_corroborated";
    reasons.push(`${agreeingRegions.length} agreeing region(s), need ${config.minAgreeingRegions}`);
  }
  if (ok.length > 0 && agreeing.length * 2 <= ok.length) {
    trust = "disputed";
    reasons.push(`no majority among ${ok.length} responding region(s)`);
  }
  for (const dim of config.requireDistinct) {
    const distinct = new Set(agreeing.map((o) => domainOf(profileByRegion.get(o.region), dim)));
    if (agreeing.length > 0 && distinct.size < config.minDistinctFailureDomains) {
      if (trust === "trusted") trust = "under_corroborated";
      reasons.push(`agreeing regions share ${dim} (${[...distinct].join(", ")}); need ${config.minDistinctFailureDomains} distinct`);
    }
  }
  if (correlatedFailures.some((c) => c.dimension === "stale_upstream")) {
    // The agreement itself is suspect.
    trust = "degraded";
    reasons.push("agreeing regions are all serving the same frozen upstream value");
  } else if (correlatedFailures.length > 0 && trust !== "trusted") {
    trust = "degraded";
    reasons.push("quorum lost during a correlated failure");
  } else if (correlatedFailures.length > 0) {
    reasons.push("correlated failure detected, but enough independent regions still agree");
  }

  return {
    feedId,
    trust,
    value: trust === "trusted" ? median(agreeing.map((o) => o.outcome.value)) : null,
    agreeingRegions,
    dissentingRegions,
    failingRegions,
    missingRegions,
    correlatedFailures,
    reasons,
    evaluatedAt: now,
  };
}

function detectCorrelatedFailures(
  latest: Map<string, RegionalObservation>,
  missingRegions: string[],
  profiles: readonly RegionProfile[],
  agreeing: ReadonlyArray<RegionalObservation & { outcome: { kind: "ok"; value: number; upstreamTimestamp?: number } }>,
  config: QuorumConfig,
  now: number,
): CorrelatedFailure[] {
  const out: CorrelatedFailure[] = [];
  // A region that went silent counts as failing: a dead network path often shows up as no reports at all.
  const down = new Set<string>(missingRegions);
  const errorKindByRegion = new Map<string, FetchErrorKind>();
  for (const o of latest.values()) {
    if (o.outcome.kind === "error") {
      down.add(o.region);
      errorKindByRegion.set(o.region, o.outcome.error);
    }
  }
  const kindsFor = (regions: string[]) => [...new Set(regions.map((r) => errorKindByRegion.get(r)).filter((k): k is FetchErrorKind => !!k))].sort();

  // Shared infrastructure: most regions behind one CDN / DNS / ASN / cloud failing together.
  for (const dim of FAILURE_DOMAIN_DIMENSIONS) {
    const byValue = new Map<string, string[]>();
    for (const p of profiles) {
      const v = p[dim];
      if (!v) continue; // unknown attribute: can't attribute the failure to it
      byValue.set(v, [...(byValue.get(v) ?? []), p.region]);
    }
    for (const [value, members] of [...byValue.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const failing = members.filter((r) => down.has(r)).sort();
      if (failing.length >= config.correlatedMinRegions && failing.length / members.length >= config.correlatedMinFraction) {
        out.push({ dimension: dim, value, regions: failing, errorKinds: kindsFor(failing) });
      }
    }
  }

  // Same error everywhere, whatever the infrastructure (e.g. upstream API down, expired upstream cert).
  const byKind = new Map<FetchErrorKind, string[]>();
  for (const [r, k] of errorKindByRegion) byKind.set(k, [...(byKind.get(k) ?? []), r]);
  for (const [kind, regions] of [...byKind.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (regions.length >= config.correlatedMinRegions && regions.length / profiles.length >= config.correlatedMinFraction) {
      out.push({ dimension: "error_kind", value: kind, regions: regions.sort(), errorKinds: [kind] });
    }
  }

  // Most regions down at once with no common attribute we know of: a shared
  // network path (or our own intake) is the likeliest cause.
  if (down.size >= config.correlatedMinRegions && down.size / profiles.length >= config.correlatedMinFraction) {
    const regions = [...down].sort();
    out.push({ dimension: "widespread", value: `${regions.length}/${profiles.length}`, regions, errorKinds: kindsFor(regions) });
  }

  // Frozen upstream: every agreeing region got the same old upstream timestamp,
  // e.g. a shared cache serving one stale response to everyone.
  const stamps = agreeing.map((o) => o.outcome.upstreamTimestamp);
  if (
    agreeing.length >= config.correlatedMinRegions &&
    stamps.every((t) => t !== undefined && t === stamps[0]) &&
    now - (stamps[0] as number) > config.maxUpstreamAgeMs
  ) {
    out.push({ dimension: "stale_upstream", value: String(stamps[0]), regions: agreeing.map((o) => o.region).sort(), errorKinds: [] });
  }
  return out;
}
