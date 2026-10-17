import { createHash } from "node:crypto";

export interface StoredRawProviderPayload {
  payloadDigest: string;
  providerId: string;
  redactedRequestUrl: string;
  httpStatus: number;
  redactedHeaders: Record<string, string>;
  contentEncoding: string;
  rawBody: string;
  firstFetchedAtMs: number;
  deduplicatedCount: number;
}

export interface PayloadCaptureOutcome {
  payloadDigest: string;
  stored: boolean;
  deduplicated: boolean;
  warning: string | null;
}

const SENSITIVE_HEADER_KEYS = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "cookie",
  "set-cookie",
]);

export class ContentAddressedRawPayloadStore {
  private readonly maxPayloadBytes: number;
  private readonly blobsByDigest = new Map<string, StoredRawProviderPayload>();
  private readonly digestsByReadingId = new Map<string, string>();
  private readonly readingIdsByClaimId = new Map<string, string[]>();
  private readonly externalPersistHook?: (
    record: StoredRawProviderPayload
  ) => Promise<void>;

  constructor(options: {
    maxPayloadBytes?: number;
    externalPersistHook?: (record: StoredRawProviderPayload) => Promise<void>;
  } = {}) {
    this.maxPayloadBytes = options.maxPayloadBytes ?? 262_144; // 256 KiB default cap
    this.externalPersistHook = options.externalPersistHook;
  }

  public static computePayloadDigest(rawBody: string): string {
    const hex = createHash("sha256").update(rawBody, "utf8").digest("hex");
    return `sha256:${hex}`;
  }

  public static redactRequestUrl(rawUrl: string): string {
    return rawUrl.replace(
      /([?&](?:api_key|apikey|token|secret|key|access_token)=)[^&#]*/gi,
      "$1[REDACTED]"
    );
  }

  public static redactHeaders(
    headers: Record<string, string>
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (SENSITIVE_HEADER_KEYS.has(k.toLowerCase())) {
        out[k.toLowerCase()] = "[REDACTED]";
      } else {
        out[k.toLowerCase()] = v;
      }
    }
    return out;
  }

  /**
   * Captures a raw provider payload by SHA-256 digest and links it to `readingId`.
   * Never throws: fails open with a `warning` if size exceeds `maxPayloadBytes` or persistence fails.
   */
  public async captureProviderPayload(params: {
    readingId: string;
    providerId: string;
    requestUrl: string;
    httpStatus: number;
    headers: Record<string, string>;
    rawBody: string;
    fetchedAtMs?: number;
  }): Promise<PayloadCaptureOutcome> {
    const fetchedAtMs = params.fetchedAtMs ?? Date.now();
    const payloadDigest = ContentAddressedRawPayloadStore.computePayloadDigest(
      params.rawBody
    );
    this.digestsByReadingId.set(params.readingId, payloadDigest);

    const byteLength = Buffer.byteLength(params.rawBody, "utf8");
    if (byteLength > this.maxPayloadBytes) {
      return {
        payloadDigest,
        stored: false,
        deduplicated: false,
        warning: `PAYLOAD_SIZE_CAP_EXCEEDED: ${byteLength} bytes > ${this.maxPayloadBytes} bytes`,
      };
    }

    const existing = this.blobsByDigest.get(payloadDigest);
    if (existing) {
      existing.deduplicatedCount += 1;
      return {
        payloadDigest,
        stored: true,
        deduplicated: true,
        warning: null,
      };
    }

    const redactedHeaders = ContentAddressedRawPayloadStore.redactHeaders(
      params.headers
    );
    const record: StoredRawProviderPayload = {
      payloadDigest,
      providerId: params.providerId,
      redactedRequestUrl: ContentAddressedRawPayloadStore.redactRequestUrl(
        params.requestUrl
      ),
      httpStatus: params.httpStatus,
      redactedHeaders,
      contentEncoding: redactedHeaders["content-encoding"] ?? "identity",
      rawBody: params.rawBody,
      firstFetchedAtMs: fetchedAtMs,
      deduplicatedCount: 1,
    };

    try {
      if (this.externalPersistHook) {
        await this.externalPersistHook(record);
      }
      this.blobsByDigest.set(payloadDigest, record);
      return {
        payloadDigest,
        stored: true,
        deduplicated: false,
        warning: null,
      };
    } catch (err) {
      // Fail-open so ingestion is never blocked by raw payload storage errors
      return {
        payloadDigest,
        stored: false,
        deduplicated: false,
        warning: `PAYLOAD_STORE_WRITE_FAILED: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  public linkClaimToReadings(claimId: string, readingIds: string[]): void {
    this.readingIdsByClaimId.set(claimId, [...readingIds]);
  }

  public getPayloadByDigest(
    payloadDigest: string
  ): StoredRawProviderPayload | null {
    return this.blobsByDigest.get(payloadDigest) ?? null;
  }

  public resolveClaimToRawPayloads(
    claimId: string
  ): StoredRawProviderPayload[] {
    const readingIds = this.readingIdsByClaimId.get(claimId) ?? [];
    const results: StoredRawProviderPayload[] = [];
    for (const rId of readingIds) {
      const digest = this.digestsByReadingId.get(rId);
      if (digest) {
        const blob = this.blobsByDigest.get(digest);
        if (blob) {
          results.push(blob);
        }
      }
    }
    return results;
  }
}
