/**
 * Oracle source adapter contract.
 *
 * Every upstream data source (CoinGecko, Horizon, DeFiLlama, and any future
 * provider) implements this interface and is registered with
 * {@link OracleSourceRegistry}. Adapters are deliberately thin: they only
 * know how to fetch and parse one provider's response into a raw number.
 * Everything that makes a reading trustworthy — canonicalization, freshness
 * enforcement, quarantine, evidence capture and observability — is applied
 * uniformly by the registry, so no source can bypass it.
 */

/** Metrics the trust engine knows how to reason about. */
export type MetricId =
  /** USDC price in USD. */
  | "usdc.usd.price"
  /** XLM 24h price change, in percent (e.g. -12.5). */
  | "xlm.usd.change_24h_pct"
  /** Covered-protocol TVL change over the trailing 24h, in percent. */
  | "protocol.tvl.change_24h_pct"
  /** Latest closed Stellar ledger sequence (chain context, not a price). */
  | "stellar.ledger.latest";

/** "live" sources may drive payouts; "mock" sources never do unless explicitly allowed. */
export type TrustTier = "live" | "mock";

/** Raw HTTP evidence for one upstream response, kept for the audit trail. */
export interface ObservationEvidence {
  /** Request URL including query string. */
  url: string;
  /** HTTP status code returned by the upstream. */
  status: number;
  /** SHA-256 (hex) of the exact response body bytes. */
  bodySha256: string;
  /** Response body size in bytes. */
  bytes: number;
  /** Leading slice of the body, for human inspection. Never the full body. */
  excerpt: string;
  /** Wall-clock time (ms) the response was received. */
  capturedAt: number;
}

export interface ObservationRequest {
  metric: MetricId;
  /** Optional subject the metric is about, e.g. a DeFiLlama protocol slug. */
  subject?: string;
}

/** What an adapter returns: a parsed number plus the evidence it came from. */
export interface RawObservation {
  value: number;
  /**
   * Upstream-reported time (ms) the value refers to. Omit only when the
   * provider exposes no timestamp; the registry then falls back to the
   * fetch time and marks the observation as lacking an upstream timestamp.
   */
  observedAt?: number;
  evidence: ObservationEvidence;
  /** Extra upstream context worth keeping (e.g. protocol display name). */
  context?: Record<string, string | number>;
}

/** A canonicalized, freshness-checked observation produced by the registry. */
export interface SourceObservation {
  sourceId: string;
  trustTier: TrustTier;
  metric: MetricId;
  subject?: string;
  /** Value in the metric's canonical unit and precision. */
  value: number;
  observedAt: number;
  fetchedAt: number;
  hasUpstreamTimestamp: boolean;
  evidence: ObservationEvidence;
  context?: Record<string, string | number>;
}

export interface AdapterContext {
  timeoutMs: number;
}

export interface OracleSourceAdapter {
  /** Stable lowercase identifier, e.g. "coingecko". Used in evidence and metrics. */
  readonly id: string;
  readonly displayName: string;
  readonly trustTier: TrustTier;
  readonly metrics: readonly MetricId[];
  fetch(request: ObservationRequest, ctx: AdapterContext): Promise<RawObservation>;
}

/** Thrown by adapters when a response is well-formed HTTP but has the wrong shape. */
export class AdapterSchemaError extends Error {
  constructor(sourceId: string, detail: string) {
    super(`${sourceId}: unexpected response shape — ${detail}`);
    this.name = "AdapterSchemaError";
  }
}
