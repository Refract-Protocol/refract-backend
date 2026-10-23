import { InMemoryNonceStore, NonceStore } from "./nonce-store";
import { IngestedReading, OracleSourceAdapter, PullOracleSource, PushOracleSource, SourceReading } from "./oracle-source";
import { WebhookRejectReason, assertCredentialsUsable, readSignatureHeaders, verifyWebhookSignature } from "./webhook-signature";

export interface IngestionConfig {
  /** Reject readings older than this, ms. */
  maxReadingAgeMs: number;
  /** Reject readings dated further than this into the future, ms. */
  maxFutureSkewMs: number;
  /** Allowed |now - webhook timestamp|, ms. */
  webhookMaxSkewMs: number;
  /** Largest webhook body accepted, bytes. */
  maxWebhookBodyBytes: number;
  /** Most readings accepted in a single webhook delivery. */
  maxReadingsPerDelivery: number;
}

export const DEFAULT_INGESTION_CONFIG: IngestionConfig = {
  maxReadingAgeMs: 5 * 60_000,
  maxFutureSkewMs: 30_000,
  webhookMaxSkewMs: 5 * 60_000,
  maxWebhookBodyBytes: 64 * 1024,
  maxReadingsPerDelivery: 100,
};

export type ReadingRejectReason =
  | "feed_not_registered"
  | "invalid_value"
  | "stale"
  | "future_dated"
  | "not_newer_than_last"
  | "sequence_not_increasing"
  | "after_signed_timestamp";

export interface IngestionResult {
  accepted: IngestedReading[];
  rejected: Array<{ reading: SourceReading; reason: ReadingRejectReason }>;
}

export type WebhookIngestionResult =
  | ({ ok: true } & IngestionResult)
  | { ok: false; status: 401; reason: WebhookRejectReason | "unknown_source" }
  | { ok: false; status: 400 | 413; reason: "body_too_large" | "invalid_json" | "invalid_payload" | "too_many_readings" };

export interface InboundWebhook {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer | undefined;
}

export type ReadingSink = (readings: IngestedReading[]) => void | Promise<void>;

/**
 * Single entry point for oracle readings, whichever way they arrive.
 *
 * Push deliveries are authenticated before their body is parsed:
 *   1. size limit
 *   2. signature headers present and well-formed
 *   3. key known and active for this source, timestamp inside the skew window
 *   4. HMAC over source id, key id, timestamp, nonce and body hash
 *   5. nonce not seen before (recorded only after 2-4 pass)
 *   6. JSON parse and source-specific parse
 * Then push and pull readings get the same per-reading checks: feed
 * allow-list, finite value, freshness, and strictly increasing observedAt /
 * sequence per (source, feed). A push reading also can't be dated after the
 * request's signed timestamp (plus skew).
 */
export class OracleIngestionPipeline {
  private readonly sources = new Map<string, OracleSourceAdapter>();
  private readonly lastAccepted = new Map<string, { observedAt: number; sequence?: number }>();
  private readonly sinks: ReadingSink[] = [];

  constructor(
    private readonly config: IngestionConfig = DEFAULT_INGESTION_CONFIG,
    private readonly nonces: NonceStore = new InMemoryNonceStore(),
  ) {}

  register(source: OracleSourceAdapter): void {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(source.id)) throw new Error(`Invalid oracle source id: ${source.id}`);
    if (this.sources.has(source.id)) throw new Error(`Oracle source ${source.id} already registered`);
    if (source.feeds.length === 0) throw new Error(`Oracle source ${source.id} has no feeds`);
    if (source.mode === "push") assertCredentialsUsable(source.id, source.credentials);
    this.sources.set(source.id, source);
  }

  onReadings(sink: ReadingSink): void {
    this.sinks.push(sink);
  }

  listSources(): Array<{ id: string; mode: string; feeds: readonly string[] }> {
    return [...this.sources.values()].map((s) => ({ id: s.id, mode: s.mode, feeds: s.feeds }));
  }

  /** Polls one pull source and ingests what it returns. */
  async ingestPull(sourceId: string, now: number): Promise<IngestionResult> {
    const source = this.sources.get(sourceId);
    if (!source || source.mode !== "pull") throw new Error(`No pull source registered as ${sourceId}`);
    const readings = await (source as PullOracleSource).poll(now);
    return this.accept(source, readings, now, undefined);
  }

  /** Authenticates and ingests one webhook delivery for a push source. */
  async ingestWebhook(sourceId: string, request: InboundWebhook, now: number): Promise<WebhookIngestionResult> {
    const source = this.sources.get(sourceId);
    // Same status for unknown and pull-only sources as for a bad signature, so
    // callers can't enumerate which source ids exist.
    if (!source || source.mode !== "push") return { ok: false, status: 401, reason: "unknown_source" };
    const push = source as PushOracleSource;

    const rawBody = request.rawBody ?? Buffer.alloc(0);
    if (rawBody.length > this.config.maxWebhookBodyBytes) return { ok: false, status: 413, reason: "body_too_large" };

    const parsedHeaders = readSignatureHeaders(request.headers);
    if (!parsedHeaders.ok) return { ok: false, status: 401, reason: parsedHeaders.reason };
    const headers = parsedHeaders.value;

    const verified = verifyWebhookSignature({
      sourceId,
      credentials: push.credentials,
      headers,
      rawBody,
      now,
      maxSkewMs: this.config.webhookMaxSkewMs,
    });
    if (!verified.ok) return { ok: false, status: 401, reason: verified.reason };

    // Keep the nonce until the signed timestamp can no longer pass the skew check.
    const nonceExpiry = headers.timestamp * 1000 + this.config.webhookMaxSkewMs + 1;
    const claim = this.nonces.claim(`${sourceId}:${headers.nonce}`, nonceExpiry, now);
    if (claim === "replayed") return { ok: false, status: 401, reason: "replayed_nonce" };
    if (claim === "full") return { ok: false, status: 401, reason: "nonce_store_full" };

    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return { ok: false, status: 400, reason: "invalid_json" };
    }
    let readings: SourceReading[];
    try {
      readings = push.parse(body);
    } catch {
      return { ok: false, status: 400, reason: "invalid_payload" };
    }
    if (readings.length > this.config.maxReadingsPerDelivery) return { ok: false, status: 400, reason: "too_many_readings" };

    const signedAtMs = headers.timestamp * 1000;
    return { ok: true, ...(await this.accept(push, readings, now, signedAtMs)) };
  }

  private async accept(
    source: OracleSourceAdapter,
    readings: SourceReading[],
    now: number,
    signedAtMs: number | undefined,
  ): Promise<IngestionResult> {
    const result: IngestionResult = { accepted: [], rejected: [] };
    // Process in observation order so a batch can't be rejected for being unsorted.
    const ordered = [...readings].sort((a, b) => a.observedAt - b.observedAt || (a.sequence ?? 0) - (b.sequence ?? 0));

    for (const r of ordered) {
      const reason = this.check(source, r, now, signedAtMs);
      if (reason) {
        result.rejected.push({ reading: r, reason });
        continue;
      }
      this.lastAccepted.set(`${source.id}:${r.feedId}`, { observedAt: r.observedAt, sequence: r.sequence });
      result.accepted.push({ ...r, sourceId: source.id, mode: source.mode, receivedAt: now });
    }

    if (result.accepted.length > 0) {
      for (const sink of this.sinks) await sink(result.accepted);
    }
    return result;
  }

  private check(source: OracleSourceAdapter, r: SourceReading, now: number, signedAtMs: number | undefined): ReadingRejectReason | null {
    if (!source.feeds.includes(r.feedId)) return "feed_not_registered";
    if (typeof r.value !== "number" || !Number.isFinite(r.value) || !Number.isFinite(r.observedAt)) return "invalid_value";
    if (r.observedAt > now + this.config.maxFutureSkewMs) return "future_dated";
    if (signedAtMs !== undefined && r.observedAt > signedAtMs + this.config.maxFutureSkewMs) return "after_signed_timestamp";
    if (now - r.observedAt > this.config.maxReadingAgeMs) return "stale";
    const last = this.lastAccepted.get(`${source.id}:${r.feedId}`);
    if (last) {
      if (r.observedAt <= last.observedAt) return "not_newer_than_last";
      if (last.sequence !== undefined && (r.sequence === undefined || r.sequence <= last.sequence)) return "sequence_not_increasing";
    }
    return null;
  }
}
