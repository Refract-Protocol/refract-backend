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
