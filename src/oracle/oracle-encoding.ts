import { createHash } from "node:crypto";
import type { CoverageType } from "../common/coverage-catalog";

/** Whether a source reads real market data or returns simulated values. */
export type OracleSourceKind = "live" | "mocked";

/**
 * Trust a source has earned, ordered weakest to strongest. Index order is the
 * ranking used by the coverage source guard (issue #203).
 */
export const ORACLE_TRUST_MODES = ["mocked", "single-source", "corroborated"] as const;
export type OracleTrustMode = (typeof ORACLE_TRUST_MODES)[number];

/** Capability metadata for the source backing one coverage type. */
export interface OracleSourceCapability {
  /** Human-readable source name, used in guard error messages. */
  name: string;
  kind: OracleSourceKind;
  trustMode: OracleTrustMode;
}

/**
 * Source capability per coverage type. Must stay in step with the sources
 * actually wired into OracleService; `kind` and `trustMode` are checked against
 * each product's declared requirements in coverage-catalog.ts at startup.
 */
export const ORACLE_SOURCE_CAPABILITIES: Record<CoverageType, OracleSourceCapability> = {
  StablecoinDepeg: { name: "coingecko-horizon", kind: "live", trustMode: "single-source" },
  MarketCrash: { name: "live-market-feed", kind: "live", trustMode: "single-source" },
  LiquidationShield: { name: "nexus-liquidation-mock", kind: "mocked", trustMode: "mocked" },
  SmartContractRisk: { name: "defillama-tvl", kind: "live", trustMode: "single-source" },
  FlightDelay: { name: "aviationstack-mock", kind: "mocked", trustMode: "mocked" },
};

/**
 * Fixed-point encoding of OracleReading.value → i128 for RefractOracle.
 *
 * OracleReading.value is a JS float whose meaning depends on coverage type:
 *   - StablecoinDepeg: USDC price (e.g. 0.9998)
 *   - MarketCrash: 24h % change (e.g. -30.12)
 *   - LiquidationShield: NEXUS liquidation signal (0–1 style; see sources/liquidationShield.ts)
 *   - SmartContractRisk: TVL drop % (e.g. -12.5)
 *   - FlightDelay: delay minutes (e.g. 247)
 *
 * The on-chain oracle stores i128 fixed-point integers. Scaling is
 * deterministic (Math.round) so claim triggers are reproducible:
 *
 * | coverageType       | scale                         | example           |
 * |--------------------|-------------------------------|-------------------|
 * | StablecoinDepeg    | price × 10_000_000 (1e7)      | 0.9998 → 9998000  |
 * | MarketCrash        | percent × 100 (centipercent)  | -30.12 → -3012    |
 * | LiquidationShield  | ratio × 10_000 (bps)          | 0.42 → 4200       |
 * | SmartContractRisk  | percent × 100 (centipercent)  | -50 → -5000       |
 * | FlightDelay        | minutes as integer            | 247 → 247         |
 * | Composite          | fixed-decimal × 10^scale      | see below         |
 *
 * Composite feeds are derived from upstream consensus outputs and are
 * encoded from an exact fixed-decimal string (never from a JS float) so the
 * resulting i128 is byte-for-byte reproducible across nodes and replays.
 */

/** Maximum absolute magnitude representable by an on-chain i128. */
export const I128_MAX = (1n << 127n) - 1n;
/** Minimum (most negative) value representable by an on-chain i128. */
export const I128_MIN = -(1n << 127n);

/** Default number of decimal places used when encoding composite values. */
export const COMPOSITE_DEFAULT_SCALE = 8;

/**
 * Parse an exact fixed-decimal string (e.g. "-12.3456") into a scaled bigint.
 *
 * The input must be a plain decimal string: optional leading "-", one or more
 * integer digits, and an optional fractional part. No exponent notation, no
 * leading "+", no whitespace. This keeps parsing deterministic and avoids the
 * float rounding that `Number` would introduce.
 */
export function parseFixedDecimal(value: string, scale: number): bigint {
  if (!Number.isInteger(scale) || scale < 0 || scale > 38) {
    throw new Error(`Invalid composite scale: ${scale}`);
  }
  if (typeof value !== "string" || !/^-?\d+(\.\d+)?$/.test(value)) {
    throw new Error(`Invalid fixed-decimal string: ${String(value)}`);
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [intPart, fracPartRaw = ""] = unsigned.split(".");
  if (fracPartRaw.length > scale) {
    // Reject rather than silently truncate: rounding policy is the caller's job.
    throw new Error(
      `Fixed-decimal value ${value} has more than ${scale} fractional digits`,
    );
  }
  const fracPart = fracPartRaw.padEnd(scale, "0");
  const scaled = BigInt(intPart) * 10n ** BigInt(scale) + BigInt(fracPart || "0");
  return negative ? -scaled : scaled;
}

/** Format a scaled bigint back into an exact fixed-decimal string. */
export function formatFixedDecimal(scaled: bigint, scale: number): string {
  if (!Number.isInteger(scale) || scale < 0 || scale > 38) {
    throw new Error(`Invalid composite scale: ${scale}`);
  }
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const divisor = 10n ** BigInt(scale);
  const intPart = abs / divisor;
  const fracPart = (abs % divisor).toString().padStart(scale, "0");
  const body = scale === 0 ? intPart.toString() : `${intPart}.${fracPart}`;
  return negative ? `-${body}` : body;
}

/** Assert a scaled value fits in i128, throwing on overflow. */
export function assertI128(scaled: bigint): bigint {
  if (scaled > I128_MAX || scaled < I128_MIN) {
    throw new Error(`Composite value overflows i128: ${scaled.toString()}`);
  }
  return scaled;
}

/**
 * Encode a composite feed value (exact fixed-decimal string) into an i128.
 * Deterministic: identical (value, scale) always yields the identical bigint.
 */
export function encodeCompositeValue(value: string, scale: number): bigint {
  return assertI128(parseFixedDecimal(value, scale));
}

/**
 * Encode a composite decision payload as a canonical, byte-for-byte stable
 * string. The formula version is part of the payload so a replay always uses
 * the version that was in force when the decision was produced.
 */
export function encodeCompositeDecisionPayload(params: {
  feedId: string;
  formulaVersion: number;
  scale: number;
  value: string;
  inputDecisionIds: readonly string[];
}): string {
  const { feedId, formulaVersion, scale, value, inputDecisionIds } = params;
  if (!Number.isInteger(formulaVersion) || formulaVersion < 0) {
    throw new Error(`Invalid formula version: ${formulaVersion}`);
  }
  const scaled = encodeCompositeValue(value, scale);
  return JSON.stringify({
    feedId,
    formulaVersion,
    scale,
    value: formatFixedDecimal(scaled, scale),
    encoded: scaled.toString(),
    inputDecisionIds: [...inputDecisionIds],
  });
}

export function scaleOracleValue(coverageType: string, value: number): bigint {
  switch (coverageType) {
    case "StablecoinDepeg":
      return BigInt(Math.round(value * 10_000_000));
    case "MarketCrash":
    case "SmartContractRisk":
      return BigInt(Math.round(value * 100));
    case "LiquidationShield":
      return BigInt(Math.round(value * 10_000));
    case "FlightDelay":
      return BigInt(Math.round(value));
    case "Composite":
      // Composite values must be encoded from an exact fixed-decimal string
      // via encodeCompositeValue; a float would not be reproducible.
      throw new Error(
        "Composite coverageType requires encodeCompositeValue (fixed-decimal string)",
      );
    default:
      throw new Error(`Unknown coverageType for oracle scaling: ${coverageType}`);
  }
}

/**
 * Stable identifier for one consensus decision (feed + policy + observation
 * window). It deliberately excludes the producing node so every relayer that
 * observes the same condition derives the same key, which is what makes
 * duplicate or replayed decisions collide on the settlement unique index.
 */
export function buildDecisionId(feed: string, policyId: string, windowStart: number): string {
  return createHash("sha256").update(`${feed}|${policyId}|${windowStart}`).digest("hex");
}

/** Stable u32 discriminant matching CoverageType declaration order in the pool. */
export function coverageTypeToU32(coverageType: string): number {
  const map: Record<string, number> = {
    StablecoinDepeg: 0,
    MarketCrash: 1,
    LiquidationShield: 2,
    SmartContractRisk: 3,
    FlightDelay: 4,
    Composite: 5,
  };
  const id = map[coverageType];
  if (id === undefined) {
    throw new Error(`Unknown coverageType: ${coverageType}`);
  }
  return id;
}

/**
 * Canonical bytes every quorum submitter signs for one oracle decision.
 * Length-prefixed fields so they cannot bleed into each other:
 * "refract-oracle-v1" | contractId | coverageType u32 BE | value i128 BE | decisionId.
 */
export function buildPublishPayload(
  oracleContractId: string,
  coverageType: string,
  value: number,
  decisionId: string
): Buffer {
  const scaled = scaleOracleValue(coverageType, value);
  const valueBytes = Buffer.alloc(16);
  valueBytes.writeBigUInt64BE(BigInt.asUintN(64, scaled >> 64n), 0);
  valueBytes.writeBigUInt64BE(BigInt.asUintN(64, scaled), 8);
  const typeBytes = Buffer.alloc(4);
  typeBytes.writeUInt32BE(coverageTypeToU32(coverageType));
  const part = (input: Buffer | string): Buffer => {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length);
    return Buffer.concat([len, bytes]);
  };
  return Buffer.concat([
    part("refract-oracle-v1"),
    part(oracleContractId),
    part(typeBytes),
    part(valueBytes),
    part(decisionId),
  ]);
}

/** Deterministic id: same feed + scaled value + observation bucket yields the same id, so retries dedupe. */
export function oracleDecisionId(coverageType: string, value: number, observedAtMs: number, bucketMs = 60_000): string {
  const bucket = Math.floor(observedAtMs / bucketMs);
  return [coverageType, scaleOracleValue(coverageType, value).toString(), bucket].join(":");
}
