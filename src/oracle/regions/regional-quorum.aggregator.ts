import { InMemoryNonceStore, NonceStore } from "../sources/nonce-store";
import { WebhookCredential } from "../sources/oracle-source";
import { WebhookRejectReason, assertCredentialsUsable, readSignatureHeaders, verifyWebhookSignature } from "../sources/webhook-signature";
import {
  DEFAULT_QUORUM_CONFIG,
  FeedTrustState,
  FetchErrorKind,
  QuorumConfig,
  QuorumVerdict,
  RegionProfile,
  RegionalObservation,
  evaluateRegionalQuorum,
} from "./region-quorum";

export interface RegisteredRegion extends RegionProfile {
  /** Keys this region's poller signs its reports with. */
  keys: WebhookCredential[];
}

export interface TrustTransition {
  feedId: string;
  from: FeedTrustState | null;
  to: FeedTrustState;
  at: number;
  verdict: QuorumVerdict;
}

export type TrustListener = (t: TrustTransition) => void | Promise<void>;
export type VerdictListener = (v: QuorumVerdict) => void | Promise<void>;

const ERROR_KINDS: ReadonlySet<string> = new Set<FetchErrorKind>(["timeout", "dns", "tls", "connection", "http_4xx", "http_5xx", "invalid_response"]);
const MAX_REPORT_BYTES = 64 * 1024;
const MAX_OBSERVATIONS_PER_REPORT = 200;
const REPORT_MAX_SKEW_MS = 2 * 60_000;

export type ReportResult =
  | { ok: true; recorded: number; feeds: string[] }
  | { ok: false; status: 400 | 401 | 413; reason: WebhookRejectReason | "unknown_region" | "body_too_large" | "invalid_payload" };

/**
 * Collects observations from independently deployed regional pollers and
 * turns them into per-feed trust verdicts.
 *
 * Region reports are authenticated with the same signed-webhook scheme as
 * push oracle sources (the region name is the signed source id), so one
 * compromised region can't report on behalf of another.
 */
export class RegionalQuorumAggregator {
  private readonly regions = new Map<string, RegisteredRegion>();
  /** feedId -> region -> latest observation */
  private readonly observations = new Map<string, Map<string, RegionalObservation>>();
  private readonly lastTrust = new Map<string, FeedTrustState>();
  private readonly listeners: TrustListener[] = [];
  private readonly verdictListeners: VerdictListener[] = [];

  constructor(
    private readonly config: QuorumConfig = DEFAULT_QUORUM_CONFIG,
    private readonly nonces: NonceStore = new InMemoryNonceStore(),
  ) {}

  registerRegion(region: RegisteredRegion): void {
    if (!/^[a-z0-9-]{2,32}$/.test(region.region)) throw new Error(`Invalid region name: ${region.region}`);
    if (this.regions.has(region.region)) throw new Error(`Region ${region.region} already registered`);
    assertCredentialsUsable(region.region, region.keys);
    this.regions.set(region.region, region);
  }

  profiles(): RegionProfile[] {
    return [...this.regions.values()].map(({ keys: _keys, ...profile }) => profile);
  }

  onTrustTransition(listener: TrustListener): void {
    this.listeners.push(listener);
  }

  /** Called with every verdict evaluate() computes, e.g. to keep a history of trusted values. */
  onVerdict(listener: VerdictListener): void {
    this.verdictListeners.push(listener);
  }

  /** Records an observation that has already been authenticated. Older-than-latest reports are dropped. */
  record(obs: RegionalObservation): boolean {
    if (!this.regions.has(obs.region)) return false;
    const byRegion = this.observations.get(obs.feedId) ?? new Map<string, RegionalObservation>();
    const prev = byRegion.get(obs.region);
    if (prev && prev.observedAt >= obs.observedAt) return false;
    byRegion.set(obs.region, obs);
    this.observations.set(obs.feedId, byRegion);
    return true;
  }

  /** Authenticates a signed report from a regional poller, records it, and re-evaluates the affected feeds. */
  async ingestSignedReport(
    region: string,
    request: { headers: Record<string, string | string[] | undefined>; rawBody: Buffer | undefined },
    now: number,
  ): Promise<ReportResult> {
    const registered = this.regions.get(region);
    if (!registered) return { ok: false, status: 401, reason: "unknown_region" };
    const rawBody = request.rawBody ?? Buffer.alloc(0);
    if (rawBody.length > MAX_REPORT_BYTES) return { ok: false, status: 413, reason: "body_too_large" };

    const headers = readSignatureHeaders(request.headers);
    if (!headers.ok) return { ok: false, status: 401, reason: headers.reason };
    const verified = verifyWebhookSignature({
      sourceId: region,
      credentials: registered.keys,
      headers: headers.value,
      rawBody,
      now,
      maxSkewMs: REPORT_MAX_SKEW_MS,
    });
    if (!verified.ok) return { ok: false, status: 401, reason: verified.reason };
    const claim = this.nonces.claim(`region:${region}:${headers.value.nonce}`, headers.value.timestamp * 1000 + REPORT_MAX_SKEW_MS + 1, now);
    if (claim !== "fresh") return { ok: false, status: 401, reason: claim === "replayed" ? "replayed_nonce" : "nonce_store_full" };

    let observations: RegionalObservation[];
    try {
      observations = parseReport(region, JSON.parse(rawBody.toString("utf8")));
    } catch {
      return { ok: false, status: 400, reason: "invalid_payload" };
    }

    let recorded = 0;
    const feeds = new Set<string>();
    for (const o of observations) {
      // A region can't backdate or future-date beyond the signed request time.
      if (o.observedAt > headers.value.timestamp * 1000 + 30_000) continue;
      if (this.record(o)) {
        recorded++;
        feeds.add(o.feedId);
      }
    }
    for (const feedId of [...feeds].sort()) await this.evaluate(feedId, now);
    return { ok: true, recorded, feeds: [...feeds].sort() };
  }

  /** Current verdict for a feed. Notifies listeners when the trust state changes. */
  async evaluate(feedId: string, now: number): Promise<QuorumVerdict> {
    const verdict = this.peek(feedId, now);
    for (const l of this.verdictListeners) await l(verdict);
    const from = this.lastTrust.get(feedId) ?? null;
    if (from !== verdict.trust) {
      this.lastTrust.set(feedId, verdict.trust);
      const transition: TrustTransition = { feedId, from, to: verdict.trust, at: now, verdict };
      for (const l of this.listeners) await l(transition);
    }
    return verdict;
  }

  /** Verdict without side effects. */
  peek(feedId: string, now: number): QuorumVerdict {
    const obs = [...(this.observations.get(feedId)?.values() ?? [])];
    return evaluateRegionalQuorum(feedId, obs, this.profiles(), this.config, now);
  }

  /** Re-evaluates every known feed; call on a timer so silent regions age out and get noticed. */
  async evaluateAll(now: number): Promise<QuorumVerdict[]> {
    const out: QuorumVerdict[] = [];
    for (const feedId of [...this.observations.keys()].sort()) out.push(await this.evaluate(feedId, now));
    return out;
  }

  /**
   * Cross-region quorum is only enforced once enough regions are registered
   * to reach it. With fewer (e.g. a single-region deployment) the feed is
   * left ungated, matching the behavior before regional ingestion existed;
   * the module logs a warning and the ops endpoint shows `quorumEnforced: false`.
   */
  isQuorumEnforced(): boolean {
    return this.regions.size >= this.config.minAgreeingRegions;
  }

  quorumStatus(): { quorumEnforced: boolean; registeredRegions: number; minAgreeingRegions: number; warning: string | null } {
    const enforced = this.isQuorumEnforced();
    return {
      quorumEnforced: enforced,
      registeredRegions: this.regions.size,
      minAgreeingRegions: this.config.minAgreeingRegions,
      warning: enforced
        ? null
        : `Only ${this.regions.size} region(s) registered; need ${this.config.minAgreeingRegions} for cross-region quorum. Oracle readings are NOT regionally corroborated.`,
    };
  }

  /** The agreed value, or null unless the feed is currently trusted. */
  trustedValue(feedId: string, now: number): number | null {
    const v = this.peek(feedId, now);
    return v.trust === "trusted" ? v.value : null;
  }

  /**
   * Last evaluated trust state for gating claims, or null when the feed isn't
   * quorum-managed (never reported on, or quorum not enforced).
   */
  trustState(feedId: string): FeedTrustState | null {
    if (!this.isQuorumEnforced()) return null;
    return this.lastTrust.get(feedId) ?? null;
  }
}

/** Body: { observations: [{ feedId, observedAt, value?, upstreamTimestamp?, error? }] }. Region comes from the signed path, never the body. */
export function parseReport(region: string, body: unknown): RegionalObservation[] {
  const list = (body as { observations?: unknown })?.observations;
  if (!Array.isArray(list) || list.length > MAX_OBSERVATIONS_PER_REPORT) throw new Error("observations must be an array of at most 200");
  return list.map((raw, i) => {
    const r = raw as Record<string, unknown>;
    if (!r || typeof r.feedId !== "string" || typeof r.observedAt !== "number" || !Number.isFinite(r.observedAt)) {
      throw new Error(`observations[${i}] needs feedId and observedAt`);
    }
    if (typeof r.error === "string") {
      if (!ERROR_KINDS.has(r.error)) throw new Error(`observations[${i}].error unknown`);
      return { region, feedId: r.feedId, observedAt: r.observedAt, outcome: { kind: "error", error: r.error as FetchErrorKind } };
    }
    if (typeof r.value !== "number" || !Number.isFinite(r.value)) throw new Error(`observations[${i}].value must be finite`);
    const upstreamTimestamp = typeof r.upstreamTimestamp === "number" ? r.upstreamTimestamp : undefined;
    return {
      region,
      feedId: r.feedId,
      observedAt: r.observedAt,
      outcome: { kind: "ok", value: r.value, ...(upstreamTimestamp !== undefined ? { upstreamTimestamp } : {}) },
    };
  });
}

/** Reads ORACLE_REGIONS: JSON array of { region, cdn?, dnsProvider?, asn?, cloudProvider?, keys: [...] }. */
export function regionsFromEnv(raw: string | undefined): RegisteredRegion[] {
  if (!raw || raw.trim() === "") return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("ORACLE_REGIONS must be a JSON array");
  return parsed.map((r: RegisteredRegion, i) => {
    if (!r || typeof r.region !== "string" || !Array.isArray(r.keys)) throw new Error(`ORACLE_REGIONS[${i}] needs region and keys[]`);
    return r;
  });
}
