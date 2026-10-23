/**
 * Oracle source adapter contract.
 *
 * A source either gets polled by us ("pull") or delivers readings to us over
 * a signed inbound webhook ("push"). Both kinds produce SourceReadings that
 * go through the same OracleIngestionPipeline checks (feed allow-list,
 * freshness, per-feed ordering), so a push source is never trusted more than
 * a pull source.
 */

export interface SourceReading {
  /** Feed identifier, e.g. "usdc-usd". A source may only publish feeds it is registered for. */
  feedId: string;
  /** OracleReading coverage type name, e.g. "StablecoinDepeg". */
  coverageType: string;
  value: number;
  /** When the provider observed the value, epoch ms. */
  observedAt: number;
  /** Optional provider sequence number; must strictly increase per feed when present. */
  sequence?: number;
}

/** Reading as accepted by the pipeline, tagged with where and how it arrived. */
export interface IngestedReading extends SourceReading {
  sourceId: string;
  mode: OracleSourceMode;
  receivedAt: number;
}

export type OracleSourceMode = "pull" | "push";

interface OracleSourceBase {
  readonly id: string;
  /** Feeds this source may publish. Readings for any other feed are rejected. */
  readonly feeds: readonly string[];
}

export interface PullOracleSource extends OracleSourceBase {
  readonly mode: "pull";
  poll(now: number): Promise<SourceReading[]>;
}

/** One HMAC signing key. Several may be active at once to allow rotation. */
export interface WebhookCredential {
  keyId: string;
  /** Shared secret; at least 32 bytes. */
  secret: string;
  /** Epoch ms the key becomes valid (inclusive). */
  notBefore?: number;
  /** Epoch ms the key stops being valid (exclusive). */
  notAfter?: number;
}

export interface PushOracleSource extends OracleSourceBase {
  readonly mode: "push";
  readonly credentials: readonly WebhookCredential[];
  /**
   * Turns an already-authenticated, already-JSON-parsed body into readings.
   * Never called before the signature, timestamp and nonce checks pass.
   */
  parse(body: unknown): SourceReading[];
}

export type OracleSourceAdapter = PullOracleSource | PushOracleSource;
