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
