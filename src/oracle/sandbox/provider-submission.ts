import { Keypair, StrKey } from "@stellar/stellar-sdk";

/**
 * Signed reading format accepted by the provider submission API.
 *
 * A provider signs a canonical, newline-separated message with its Stellar
 * ed25519 key. The message starts with a domain tag that names the
 * deployment ("sandbox" here). A signature made for the sandbox therefore
 * never verifies against a production deployment, and the reverse is also
 * true.
 *
 * `value` is a decimal string, not a JSON number. Different languages print
 * floats differently, and the signed bytes must be identical on both ends.
 */
export interface ProviderReadingSubmission {
  /** Provider's Stellar public key (G…). Also the provider id. */
  providerId: string;
  /** Feed the reading belongs to, e.g. "StablecoinDepeg". */
  feed: string;
  /** Decimal string, e.g. "0.9998" or "-30.12". */
  value: string;
  /** ISO-8601 time the provider observed the value. */
  observedAt: string;
  /** Unique per provider. Reusing a nonce is rejected as a replay. */
  nonce: string;
  /** Base64 ed25519 signature over `canonicalReadingMessage(...)`. */
  signature: string;
}

export const READING_MESSAGE_VERSION = "refract-oracle-reading:v1";
export type SubmissionDomain = "sandbox" | "production";

const DECIMAL_RE = /^-?(0|[1-9]\d{0,17})(\.\d{1,18})?$/;
const NONCE_RE = /^[A-Za-z0-9_-]{8,128}$/;
const FEED_RE = /^[A-Za-z][A-Za-z0-9_]{1,63}$/;

export function canonicalReadingMessage(
  domain: SubmissionDomain,
  sub: Omit<ProviderReadingSubmission, "signature">,
): string {
  return [
    READING_MESSAGE_VERSION,
    domain,
    sub.providerId,
    sub.feed,
    sub.value,
    sub.observedAt,
    sub.nonce,
  ].join("\n");
}

/** Signs a reading. Used by tests, docs, and the sample signing script. */
export function signReading(
  domain: SubmissionDomain,
  secret: string,
  sub: Omit<ProviderReadingSubmission, "signature" | "providerId">,
): ProviderReadingSubmission {
  const keypair = Keypair.fromSecret(secret);
  const unsigned = { ...sub, providerId: keypair.publicKey() };
  const signature = keypair
    .sign(Buffer.from(canonicalReadingMessage(domain, unsigned), "utf8"))
    .toString("base64");
  return { ...unsigned, signature };
}

export function verifyReadingSignature(
  domain: SubmissionDomain,
  sub: ProviderReadingSubmission,
): boolean {
  try {
    const keypair = Keypair.fromPublicKey(sub.providerId);
    const signature = Buffer.from(sub.signature, "base64");
    if (signature.length !== 64) return false;
    return keypair.verify(
      Buffer.from(canonicalReadingMessage(domain, sub), "utf8"),
      signature,
    );
  } catch {
    return false;
  }
}

/**
 * Checks shape only (no signature, no freshness). Returns a list of problems
 * so a provider sees every mistake in one response.
 */
export function validateSubmissionShape(input: unknown): {
  submission?: ProviderReadingSubmission;
  problems: string[];
} {
  const problems: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { problems: ["body must be a JSON object"] };
  }
  const raw = input as Record<string, unknown>;
  const str = (key: string): string | undefined => {
    const v = raw[key];
    if (typeof v !== "string" || v.length === 0) {
      problems.push(`${key} must be a non-empty string`);
      return undefined;
    }
    return v;
  };

  const providerId = str("providerId");
  const feed = str("feed");
  const value = str("value");
  const observedAt = str("observedAt");
  const nonce = str("nonce");
  const signature = str("signature");

  if (providerId && !StrKey.isValidEd25519PublicKey(providerId)) {
    problems.push("providerId must be a Stellar public key (G…)");
  }
  if (feed && !FEED_RE.test(feed)) problems.push("feed has an invalid format");
  if (value && !DECIMAL_RE.test(value)) {
    problems.push('value must be a decimal string such as "0.9998" or "-30.12"');
  }
  if (observedAt && Number.isNaN(Date.parse(observedAt))) {
    problems.push("observedAt must be an ISO-8601 timestamp");
  }
  if (nonce && !NONCE_RE.test(nonce)) {
    problems.push("nonce must be 8-128 characters of [A-Za-z0-9_-]");
  }

  if (problems.length > 0) return { problems };
  return {
    submission: {
      providerId: providerId!,
      feed: feed!,
      value: value!,
      observedAt: observedAt!,
      nonce: nonce!,
      signature: signature!,
    },
    problems,
  };
}
