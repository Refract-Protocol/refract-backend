import { createHmac, timingSafeEqual } from "node:crypto";

export interface ProviderSigningKey {
  keyId: string;
  secret: string;
  validFromMs: number;
  validUntilMs: number;
  revoked: boolean;
}

export interface InboundProviderResponse {
  sourceId: string;
  keyId: string;
  timestampMs: number;
  rawBody: string;
  signatureHex: string;
}

export interface SignatureVerificationResult {
  verified: boolean;
  reason: "ok" | "missing_or_unknown_key" | "key_revoked" | "key_expired" | "timestamp_out_of_window" | "invalid_signature";
  keyId?: string;
}

export class ProviderSignatureVerifier {
  private readonly keysBySource = new Map<string, Map<string, ProviderSigningKey>>();
  private readonly maxClockSkewMs: number;

  constructor(maxClockSkewMs = 60_000) {
    this.maxClockSkewMs = maxClockSkewMs;
  }

  public registerKey(sourceId: string, key: ProviderSigningKey): void {
    if (!this.keysBySource.has(sourceId)) {
      this.keysBySource.set(sourceId, new Map());
    }
    this.keysBySource.get(sourceId)!.set(key.keyId, { ...key });
  }

  public revokeKey(sourceId: string, keyId: string): void {
    const key = this.keysBySource.get(sourceId)?.get(keyId);
    if (key) {
      key.revoked = true;
    }
  }

  public computeSignature(secret: string, timestampMs: number, rawBody: string): string {
    return createHmac("sha256", secret)
      .update(`${timestampMs}.${rawBody}`)
      .digest("hex");
  }

  public verifyInboundResponse(
    response: InboundProviderResponse,
    nowMs: number
  ): SignatureVerificationResult {
    const key = this.keysBySource.get(response.sourceId)?.get(response.keyId);
    if (!key) {
      return { verified: false, reason: "missing_or_unknown_key" };
    }
    if (key.revoked) {
      return { verified: false, reason: "key_revoked", keyId: key.keyId };
    }
    if (nowMs < key.validFromMs || nowMs > key.validUntilMs) {
      return { verified: false, reason: "key_expired", keyId: key.keyId };
    }
    if (Math.abs(nowMs - response.timestampMs) > this.maxClockSkewMs) {
      return { verified: false, reason: "timestamp_out_of_window", keyId: key.keyId };
    }

    const expectedHex = this.computeSignature(key.secret, response.timestampMs, response.rawBody);
    const expectedBuf = Buffer.from(expectedHex, "utf8");
    const actualBuf = Buffer.from(response.signatureHex, "utf8");

    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
      return { verified: false, reason: "invalid_signature", keyId: key.keyId };
    }

    return { verified: true, reason: "ok", keyId: key.keyId };
  }

  public signOutboundRequest(params: {
    sourceId: string;
    keyId: string;
    method: string;
    path: string;
    timestampMs: number;
  }): Record<string, string> {
    const key = this.keysBySource.get(params.sourceId)?.get(params.keyId);
    if (!key || key.revoked) {
      throw new Error(`Cannot sign outbound request: active key '${params.keyId}' not found for '${params.sourceId}'`);
    }
    const payload = `${params.method.toUpperCase()}:${params.path}`;
    const sig = this.computeSignature(key.secret, params.timestampMs, payload);
    return {
      "X-Oracle-Key-Id": key.keyId,
      "X-Oracle-Timestamp": String(params.timestampMs),
      "X-Oracle-Signature": sig,
    };
  }
}
