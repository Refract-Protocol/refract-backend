export type PublicFeedOperationalState =
  | "healthy"
  | "degraded_settled"
  | "paused_no_authoritative_value"
  | "unknown";

export interface PublicSourceProvenance {
  sourceId: string;
  independenceGroup: string;
  healthy: boolean;
  quarantined: boolean;
  lastObservedAtMs: number | null;
}

export interface PublicDecisionProvenanceRecord {
  decisionId: string;
  feedId: string;
  authoritativeValue: number | null;
  quorumAchieved: number;
  quorumRequired: number;
  participatingSources: string[];
  decidedAtMs: number;
}

export interface PublicFeedTrustStatusResponse {
  schemaVersion: "v1";
  feedId: string;
  trustMode: "single" | "corroborated" | "decentralized";
  operationalState: PublicFeedOperationalState;
  authoritativeValue: number | null;
  lastDecidedAtMs: number | null;
  sources: PublicSourceProvenance[];
  recentDecisions: PublicDecisionProvenanceRecord[];
  fromCache: boolean;
}

const SECRET_KEYS = new Set([
  "relayerkey",
  "apikey",
  "secret",
  "privatekey",
  "operatorprivatenote",
  "rawcredentials",
]);

export function stripSecretFields<T extends Record<string, unknown>>(
  obj: T
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEYS.has(k.toLowerCase())) {
      continue;
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      clean[k] = stripSecretFields(v as Record<string, unknown>);
    } else {
      clean[k] = v;
    }
  }
  return clean;
}

export class OracleTrustStatusService {
  private readonly cacheTtlMs: number;
  private readonly maxPageLimit: number;
  private readonly feedMeta = new Map<
    string,
    {
      trustMode: "single" | "corroborated" | "decentralized";
      paused: boolean;
      sources: PublicSourceProvenance[];
    }
  >();
  private readonly decisionsByFeed = new Map<
    string,
    PublicDecisionProvenanceRecord[]
  >();
  private readonly cache = new Map<
    string,
    { expiresAtMs: number; response: PublicFeedTrustStatusResponse }
  >();

  constructor(options?: { cacheTtlMs?: number; maxPageLimit?: number }) {
    this.cacheTtlMs = options?.cacheTtlMs ?? 5_000;
    this.maxPageLimit = options?.maxPageLimit ?? 25;
  }

  public configureFeed(params: {
    feedId: string;
    trustMode: "single" | "corroborated" | "decentralized";
    paused: boolean;
    sources: PublicSourceProvenance[];
  }): void {
    this.feedMeta.set(params.feedId, {
      trustMode: params.trustMode,
      paused: params.paused,
      sources: params.sources.map((s) => ({ ...s })),
    });
    this.cache.delete(params.feedId);
  }

  public recordDecisionAndInvalidate(
    decision: PublicDecisionProvenanceRecord
  ): void {
    const list = this.decisionsByFeed.get(decision.feedId) ?? [];
    list.unshift({
      ...decision,
      participatingSources: [...decision.participatingSources],
    });
    this.decisionsByFeed.set(decision.feedId, list);
    // Explicitly invalidate cached response on new decision
    this.cache.delete(decision.feedId);
  }

  public getFeedTrustStatus(params: {
    feedId: string;
    limit?: number;
    nowMs?: number;
  }): PublicFeedTrustStatusResponse {
    const nowMs = params.nowMs ?? Date.now();
    const boundedLimit = Math.min(
      this.maxPageLimit,
      Math.max(1, params.limit ?? 10)
    );

    const cached = this.cache.get(params.feedId);
    if (cached && nowMs < cached.expiresAtMs) {
      return {
        ...cached.response,
        recentDecisions: cached.response.recentDecisions.slice(0, boundedLimit),
        fromCache: true,
      };
    }

    const meta = this.feedMeta.get(params.feedId);
    const decisions = this.decisionsByFeed.get(params.feedId) ?? [];
    const latest = decisions[0] ?? null;

    let operationalState: PublicFeedOperationalState = "unknown";
    let authoritativeValue: number | null = null;

    if (meta) {
      if (meta.paused) {
        operationalState = "paused_no_authoritative_value";
        authoritativeValue = null;
      } else if (!latest) {
        operationalState = "unknown";
        authoritativeValue = null;
      } else {
        const hasDegradedSource = meta.sources.some(
          (s) => !s.healthy || s.quarantined
        );
        operationalState = hasDegradedSource ? "degraded_settled" : "healthy";
        authoritativeValue = latest.authoritativeValue;
      }
    }

    const response: PublicFeedTrustStatusResponse = {
      schemaVersion: "v1",
      feedId: params.feedId,
      trustMode: meta?.trustMode ?? "corroborated",
      operationalState,
      authoritativeValue,
      lastDecidedAtMs: latest?.decidedAtMs ?? null,
      sources: meta ? meta.sources.map((s) => ({ ...s })) : [],
      recentDecisions: decisions.slice(0, boundedLimit),
      fromCache: false,
    };

    this.cache.set(params.feedId, {
      expiresAtMs: nowMs + this.cacheTtlMs,
      response,
    });

    return response;
  }
}
