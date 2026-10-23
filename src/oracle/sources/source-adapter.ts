/** Feed kinds that can be corroborated across independent providers. */
export type FeedKind = "price" | "tvl";

/**
 * Canonical observation produced by every adapter. Units are fixed per feed:
 * `price` is USD per unit of the requested asset, `tvl` is USD.
 */
export interface SourceObservation {
  source: string;
  feed: FeedKind;
  subject: string;
  value: number;
  /** Provider-reported observation time (epoch ms), not our fetch time. */
  observedAt: number;
}

/** Documented provenance so reviewers can judge whether corroboration is real. */
export interface SourceIndependence {
  /** Where the provider's numbers originate. */
  upstreamOrigin: string;
  /** Expected provider update cadence. */
  cadence: string;
  authentication: "none" | "api-key";
  /** Persistent, benign differences versus other providers for this feed. */
  knownDivergence: string;
}

export interface SourceAdapter {
  readonly id: string;
  readonly feed: FeedKind;
  readonly independence: SourceIndependence;
  fetch(subject: string): Promise<SourceObservation>;
}

export type FetchJson = (
  url: string,
  headers?: Record<string, string>,
) => Promise<unknown>;

export function createFetchJson(timeoutMs: number): FetchJson {
  return async (url, headers) => {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    }
    return res.json();
  };
}

/** Reject non-finite / non-positive provider values before they reach consensus. */
export function assertPositiveFinite(source: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${source}: invalid value ${String(value)}`);
  }
  return value;
}

/**
 * Contract for every payout-triggering data feed.
 *
 * Adapters are stateless: they receive `fetch` and a clock through their
 * constructor so tests can replay recorded responses. They never throw for
 * upstream failures; every failure comes back as a typed `SourceError` so the
 * caller can decide whether to fall back to another source for the same
 * coverage type.
 */
export interface SourceReading {
  value: number;
  unit: string;
  /** Epoch milliseconds at which the upstream observed the value. */
  observedAt: number;
  sourceId: string;
  rawPayload: unknown;
  /** Adapter-reported confidence in [0, 1]. */
  confidence: number;
}

export type SourceErrorCode = "timeout" | "http_status" | "malformed" | "network";

export class SourceError extends Error {
  constructor(
    readonly code: SourceErrorCode,
    readonly sourceId: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

export interface FetchReadingParams {
  coverageType: string;
}

export type FetchReadingResult =
  | { ok: true; reading: SourceReading }
  | { ok: false; error: SourceError };

export interface OracleSourceAdapter {
  readonly id: string;
  readonly supportedCoverageTypes: readonly string[];
  fetchReading(params: FetchReadingParams): Promise<FetchReadingResult>;
}
