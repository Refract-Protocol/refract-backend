import { createPrivateKey, KeyObject, randomBytes, sign } from "node:crypto";
import type { CoverageTypeName } from "../src/common/coverage-type.map";
import { canonicalizeSubmission, OBSERVATION_RULES } from "../src/oracle/submission-canonical";

/**
 * Minimal client for POST /api/v1/oracle/submissions. Signs each reading with
 * the provider's Ed25519 private key over the canonical payload described in
 * docs/oracle-submissions.md. Requires Node 18+ for the global fetch.
 */

/**
 * Constructor options for {@link RefractSubmissionClient}.
 */
export interface SubmissionClientOptions {
  /**
   * Backend origin, e.g. `https://api.refract.example`. Must not have a
   * trailing slash. Used to build the submission URL:
   * `{baseUrl}/api/v1/oracle/submissions`.
   */
  baseUrl: string;
  /**
   * Provider id exactly as registered in `ORACLE_SUBMISSION_PROVIDERS` on the
   * backend. Included verbatim in every signed payload so the backend can look
   * up the matching public key.
   */
  providerId: string;
  /**
   * PKCS#8 PEM-encoded Ed25519 private key used to sign each submission.
   * Load this from an environment variable or secret manager — never commit it
   * to source control or include it in a client bundle.
   *
   * @example
   * ```ts
   * const privateKeyPem = process.env.ORACLE_PROVIDER_PRIVATE_KEY!;
   * ```
   */
  privateKeyPem: string;
}

export interface ReadingInput {
  coverageType: CoverageTypeName;
  /** Canonical decimal string, e.g. "0.9998". Never a JS number. */
  value: string;
  /** Defaults to the unit the server expects for this coverage type. */
  unit?: string;
  /** Defaults to now. */
  observedAt?: Date;
  /** Defaults to 16 random bytes, base64url-encoded. */
  nonce?: string;
}

export interface SignedSubmission {
  provider_id: string;
  coverage_type: string;
  value: string;
  unit: string;
  observed_at: string;
  nonce: string;
  signature: string;
}

export class SubmissionRejectedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "SubmissionRejectedError";
  }
}

/**
 * Client for submitting oracle readings to the Refract backend.
 *
 * Each reading is signed with the provider's Ed25519 private key over the
 * canonical payload defined in `docs/oracle-submissions.md`. The signature
 * covers `provider_id`, `coverage_type`, `value`, `unit`, `observed_at`, and
 * `nonce` in a deterministic order so the backend can verify it without
 * trusting the wire representation.
 *
 * **Requirements:** Node.js 18 or later (uses the global `fetch`).
 *
 * @example
 * ```ts
 * // Start the backend in sandbox mode:
 * //   SANDBOX_MODE=true npm run dev
 *
 * import { RefractSubmissionClient } from './submission-client';
 *
 * const client = new RefractSubmissionClient({
 *   baseUrl: 'http://localhost:4001',
 *   providerId: 'my-provider',
 *   privateKeyPem: process.env.ORACLE_PROVIDER_PRIVATE_KEY!,
 * });
 *
 * // Sign and send one reading:
 * await client.submit({
 *   coverageType: 'StablecoinDepeg',
 *   value: '0.9998',
 * });
 *
 * // Sign offline (useful for testing or batch preparation):
 * const signed = client.sign({
 *   coverageType: 'MarketCrash',
 *   value: '-12.5',
 *   observedAt: new Date('2024-06-01T12:00:00Z'),
 * });
 * console.log(signed.signature);
 * ```
 */
export class RefractSubmissionClient {
  private readonly privateKey: KeyObject;

  /**
   * @param options - {@link SubmissionClientOptions} containing the backend
   * URL, provider id, and PKCS#8 PEM private key.
   */
  constructor(private readonly options: SubmissionClientOptions) {
    this.privateKey = createPrivateKey(options.privateKeyPem);
  }

  /** Builds and signs a request body without sending it. Useful for tests and offline signing. */
  sign(reading: ReadingInput): SignedSubmission {
    const fields = {
      provider_id: this.options.providerId,
      coverage_type: reading.coverageType,
      value: reading.value,
      unit: reading.unit ?? OBSERVATION_RULES[reading.coverageType].unit,
      observed_at: (reading.observedAt ?? new Date()).toISOString(),
      nonce: reading.nonce ?? randomBytes(16).toString("base64url"),
    };
    const canonical = canonicalizeSubmission(fields);
    const signature = sign(null, Buffer.from(canonical, "utf8"), this.privateKey).toString("base64");
    return { ...fields, signature };
  }

  /** Signs and POSTs one reading. Throws SubmissionRejectedError on any non-2xx response. */
  async submit(reading: ReadingInput): Promise<unknown> {
    const response = await fetch(`${this.options.baseUrl}/api/v1/oracle/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(this.sign(reading)),
    });
    const body = (await response.json().catch(() => undefined)) as
      | { code?: string; error?: string; message?: string }
      | undefined;
    if (!response.ok) {
      throw new SubmissionRejectedError(
        response.status,
        body?.code,
        body?.error ?? body?.message ?? `Submission failed with HTTP ${response.status}`,
      );
    }
    return body;
  }
}
