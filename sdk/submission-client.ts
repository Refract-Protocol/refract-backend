import { createPrivateKey, KeyObject, randomBytes, sign } from "node:crypto";
import type { CoverageTypeName } from "../src/common/coverage-type.map";
import { canonicalizeSubmission, OBSERVATION_RULES } from "../src/oracle/submission-canonical";

/**
 * Minimal client for POST /api/v1/oracle/submissions. Signs each reading with
 * the provider's Ed25519 private key over the canonical payload described in
 * docs/oracle-submissions.md. Requires Node 18+ for the global fetch.
 */

export interface SubmissionClientOptions {
  /** Backend origin, e.g. https://api.refract.example */
  baseUrl: string;
  /** Provider id as registered in ORACLE_SUBMISSION_PROVIDERS. */
  providerId: string;
  /** PKCS#8 PEM-encoded Ed25519 private key. Keep it in a secret store, never in source. */
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

export class RefractSubmissionClient {
  private readonly privateKey: KeyObject;

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
