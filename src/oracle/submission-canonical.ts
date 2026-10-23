import type { CoverageTypeName } from "../common/coverage-type.map";

/**
 * Canonical form of a signed third-party oracle submission. Shared by the
 * server verifier and the client SDK (sdk/submission-client.ts) so both sides
 * sign and verify the exact same bytes. See docs/oracle-submissions.md for the
 * normative specification third parties implement against.
 */

/** Fields covered by the provider's detached Ed25519 signature. */
export interface SignedSubmissionFields {
  provider_id: string;
  coverage_type: string;
  value: string;
  unit: string;
  observed_at: string;
  nonce: string;
}

/**
 * Canonical JSON: keys sorted ascending, no insignificant whitespace, every
 * value a string. `value` is the decimal string exactly as submitted, never a
 * JSON number, so there is no float re-encoding ambiguity.
 */
export function canonicalizeSubmission(fields: SignedSubmissionFields): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(fields).sort()) {
    sorted[key] = fields[key as keyof SignedSubmissionFields];
  }
  return JSON.stringify(sorted);
}

/**
 * Decimal value: optional leading minus, no leading zeros, no exponent, no
 * trailing zeros in the fraction, at most 6 fractional digits (numeric(20,6)).
 * "-0" is rejected so every value has exactly one encoding.
 */
export const DECIMAL_VALUE_PATTERN = /^(?!-0$)-?(0|[1-9]\d{0,13})(\.\d{0,5}[1-9])?$/;

/** RFC 3339 UTC timestamp with optional millisecond precision, e.g. 2026-10-19T12:00:00.000Z. */
export const OBSERVED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Nonce: 16-64 URL-safe characters (base64url alphabet). */
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Per-coverage-type unit and sanity bounds. Units are fixed server-side; a
 * client-supplied unit is only accepted if it matches. Bounds reject values
 * before they can reach corroboration. Units follow OracleReading semantics
 * documented in src/oracle/oracle-encoding.ts.
 */
export const OBSERVATION_RULES: Record<CoverageTypeName, { unit: string; min: number; max: number }> = {
  StablecoinDepeg: { unit: "usd", min: 0, max: 2 },
  MarketCrash: { unit: "percent", min: -100, max: 1000 },
  LiquidationShield: { unit: "ratio", min: 0, max: 1 },
  SmartContractRisk: { unit: "percent", min: -100, max: 100 },
  FlightDelay: { unit: "minutes", min: 0, max: 10_080 },
};
