import { randomBytes } from "crypto";
import { WebhookCredential } from "../sources/oracle-source";
import { SIGNATURE_HEADERS, signWebhook } from "../sources/webhook-signature";
import { FetchErrorKind } from "./region-quorum";

/**
 * Runs inside each regional deployment: fetches every feed from upstream on
 * its own network path and sends a signed report (successes and failures) to
 * the central RegionalQuorumAggregator.
 *
 * Failures are reported, not swallowed. They are what lets the aggregator
 * see a shared CDN or DNS provider going down across regions.
 */

export interface FeedFetcher {
  feedId: string;
  /** Returns the value and, if the upstream gives one, its own timestamp (epoch ms). */
  fetch(): Promise<{ value: number; upstreamTimestamp?: number }>;
}

export interface ReportTransport {
  post(path: string, headers: Record<string, string>, body: Buffer): Promise<void>;
}

/** Maps a fetch error to a coarse kind the aggregator can correlate on. */
export function classifyFetchError(err: unknown): FetchErrorKind {
  const e = err as { code?: string; name?: string; status?: number; response?: { status?: number } };
  const status = e?.status ?? e?.response?.status;
  if (typeof status === "number") return status >= 500 ? "http_5xx" : "http_4xx";
  switch (e?.code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
    case "ESERVFAIL":
      return "dns";
    case "ETIMEDOUT":
    case "ECONNABORTED":
    case "UND_ERR_CONNECT_TIMEOUT":
      return "timeout";
    case "ECONNREFUSED":
    case "ECONNRESET":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return "connection";
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "ERR_TLS_CERT_ALTNAME_INVALID":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
      return "tls";
  }
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return "timeout";
  return "invalid_response";
}

export function buildSignedReport(
  region: string,
  credential: WebhookCredential,
  observations: unknown[],
  now: number,
  nonce: string = randomBytes(16).toString("hex"),
): { path: string; headers: Record<string, string>; body: Buffer } {
  const body = Buffer.from(JSON.stringify({ observations }));
  const ts = Math.floor(now / 1000);
  return {
    path: `/api/v1/oracle/regions/${region}/observations`,
    headers: {
      "content-type": "application/json",
      [SIGNATURE_HEADERS.keyId]: credential.keyId,
      [SIGNATURE_HEADERS.timestamp]: String(ts),
      [SIGNATURE_HEADERS.nonce]: nonce,
      [SIGNATURE_HEADERS.signature]: signWebhook(credential.secret, region, credential.keyId, ts, nonce, body),
    },
    body,
  };
}

export class RegionalPoller {
  constructor(
    private readonly region: string,
    private readonly credential: WebhookCredential,
    private readonly fetchers: readonly FeedFetcher[],
    private readonly transport: ReportTransport,
    private readonly clock: () => number = Date.now,
  ) {}

  /** One polling round. Returns what was reported. */
  async pollOnce(): Promise<unknown[]> {
    const observations = await Promise.all(
      this.fetchers.map(async (f) => {
        const observedAt = this.clock();
        try {
          const { value, upstreamTimestamp } = await f.fetch();
          if (!Number.isFinite(value)) return { feedId: f.feedId, observedAt, error: "invalid_response" };
          return { feedId: f.feedId, observedAt, value, ...(upstreamTimestamp !== undefined ? { upstreamTimestamp } : {}) };
        } catch (err) {
          return { feedId: f.feedId, observedAt, error: classifyFetchError(err) };
        }
      }),
    );
    const report = buildSignedReport(this.region, this.credential, observations, this.clock());
    await this.transport.post(report.path, report.headers, report.body);
    return observations;
  }
}
