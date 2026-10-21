import { createHash, createHmac, timingSafeEqual } from "crypto";
import { WebhookCredential } from "./oracle-source";

/**
 * Signed inbound webhook scheme (v1).
 *
 * Headers the provider sends:
 *   x-refract-key-id     which credential signed the request
 *   x-refract-timestamp  unix seconds when the request was signed
 *   x-refract-nonce      16-128 chars [A-Za-z0-9_-], unique per request
 *   x-refract-signature  "v1=" + hex(HMAC-SHA256(secret, signingString))
 *
 * signingString = "v1\n" + sourceId + "\n" + keyId + "\n" + timestamp + "\n" + nonce + "\n" + hex(SHA256(rawBody))
 *
 * Binding the source id and key id stops a signature for one source being
 * replayed against another. Hashing the raw bytes (not re-serialized JSON)
 * means any change to the body breaks the signature.
 */

export const SIGNATURE_HEADERS = {
  keyId: "x-refract-key-id",
  timestamp: "x-refract-timestamp",
  nonce: "x-refract-nonce",
  signature: "x-refract-signature",
} as const;

export const MIN_SECRET_BYTES = 32;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SIGNATURE_PATTERN = /^v1=([0-9a-f]{64})$/;

export type WebhookRejectReason =
  | "missing_headers"
  | "malformed_headers"
  | "unknown_key"
  | "key_not_active"
  | "timestamp_out_of_window"
  | "bad_signature"
  | "replayed_nonce"
  | "nonce_store_full";

export interface SignedWebhookHeaders {
  keyId: string;
  timestamp: number; // unix seconds
  nonce: string;
  signature: string;
}

export function buildSigningString(sourceId: string, keyId: string, timestamp: number, nonce: string, rawBody: Buffer): string {
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  return `v1\n${sourceId}\n${keyId}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

/** Produces the x-refract-signature value. Used by tests and by our own regional pollers. */
export function signWebhook(secret: string, sourceId: string, keyId: string, timestamp: number, nonce: string, rawBody: Buffer): string {
  const mac = createHmac("sha256", secret).update(buildSigningString(sourceId, keyId, timestamp, nonce, rawBody)).digest("hex");
  return `v1=${mac}`;
}

/** Pulls the signature headers out of a case-insensitive header bag. */
export function readSignatureHeaders(
  headers: Record<string, string | string[] | undefined>,
): { ok: true; value: SignedWebhookHeaders } | { ok: false; reason: WebhookRejectReason } {
  const get = (name: string): string | undefined => {
    const v = headers[name] ?? headers[name.toLowerCase()];
    // Repeated headers are ambiguous; refuse rather than pick one.
    return Array.isArray(v) ? undefined : v;
  };
  const keyId = get(SIGNATURE_HEADERS.keyId);
  const ts = get(SIGNATURE_HEADERS.timestamp);
  const nonce = get(SIGNATURE_HEADERS.nonce);
  const signature = get(SIGNATURE_HEADERS.signature);
  if (!keyId || !ts || !nonce || !signature) return { ok: false, reason: "missing_headers" };
  if (!/^\d{1,12}$/.test(ts) || !NONCE_PATTERN.test(nonce) || !SIGNATURE_PATTERN.test(signature) || keyId.length > 128) {
    return { ok: false, reason: "malformed_headers" };
  }
  return { ok: true, value: { keyId, timestamp: Number(ts), nonce, signature } };
}

export interface VerifyOptions {
  sourceId: string;
  credentials: readonly WebhookCredential[];
  headers: SignedWebhookHeaders;
  rawBody: Buffer;
  /** Epoch ms. */
  now: number;
  /** Allowed |now - timestamp|, ms. */
  maxSkewMs: number;
}

/**
 * Checks key validity, timestamp window and HMAC. Does not touch the nonce
 * store; the caller records the nonce only after this passes, so unsigned
 * junk can't fill the store.
 */
export function verifyWebhookSignature(opts: VerifyOptions): { ok: true; keyId: string } | { ok: false; reason: WebhookRejectReason } {
  const { headers, now } = opts;
  const credential = opts.credentials.find((c) => c.keyId === headers.keyId);
  if (!credential) return { ok: false, reason: "unknown_key" };
  if ((credential.notBefore !== undefined && now < credential.notBefore) || (credential.notAfter !== undefined && now >= credential.notAfter)) {
    return { ok: false, reason: "key_not_active" };
  }
  if (Math.abs(now - headers.timestamp * 1000) > opts.maxSkewMs) {
    return { ok: false, reason: "timestamp_out_of_window" };
  }
  const expected = Buffer.from(
    signWebhook(credential.secret, opts.sourceId, headers.keyId, headers.timestamp, headers.nonce, opts.rawBody),
  );
  const presented = Buffer.from(headers.signature);
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true, keyId: credential.keyId };
}

export function assertCredentialsUsable(sourceId: string, credentials: readonly WebhookCredential[]): void {
  if (credentials.length === 0) throw new Error(`Push source ${sourceId} has no webhook credentials`);
  const seen = new Set<string>();
  for (const c of credentials) {
    if (seen.has(c.keyId)) throw new Error(`Push source ${sourceId} has duplicate keyId ${c.keyId}`);
    seen.add(c.keyId);
    if (Buffer.byteLength(c.secret, "utf8") < MIN_SECRET_BYTES) {
      throw new Error(`Push source ${sourceId} key ${c.keyId} secret is shorter than ${MIN_SECRET_BYTES} bytes`);
    }
  }
}
