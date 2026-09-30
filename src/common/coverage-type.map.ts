/**
 * Single source of truth for every coverage-type representation.
 *
 * The protocol expresses coverage types in four incompatible forms:
 *   1. Numeric wire value  — 0..4, validated by buy-policy.dto.ts and
 *      mirroring refract-contracts/pool/src/lib.rs CoverageType enum
 *      declaration order (DO NOT reorder without updating the contract).
 *   2. PascalCase string   — "StablecoinDepeg" etc., used by Soroban
 *      serialisation (soroban-sdk-macros maps unit enum variants as Symbols).
 *   3. snake_case Postgres  — 'stablecoin_depeg' etc., the coverage_type
 *      ENUM declared in src/db/schema.sql.
 *   4. Human-readable label — "Stablecoin Depeg" etc., for API responses.
 *
 * Previously the mapping lived implicitly in positional array ordering
 * across policy.service.ts, claim.service.ts, and quote/coverage-type.ts.
 * Reordering any one of those arrays silently rerouted claims to the wrong
 * oracle check with no compile error and no test failure.
 *
 * This module makes every representation explicit and co-located so the
 * compiler catches any missing entry.
 */

// ─── Canonical numeric codes ─────────────────────────────────────────────────

/** Wire value sent by the frontend / stored in StoredPolicy.coverageType.
 *  Must match refract-contracts CoverageType enum declaration order exactly. */
export const COVERAGE_TYPE_CODE = {
  StablecoinDepeg: 0,
  MarketCrash: 1,
  LiquidationShield: 2,
  SmartContractRisk: 3,
  FlightDelay: 4,
} as const;

export type CoverageTypeCode = (typeof COVERAGE_TYPE_CODE)[keyof typeof COVERAGE_TYPE_CODE];

/** All valid numeric codes as a plain array — useful for validation. */
export const COVERAGE_TYPE_CODES = Object.values(COVERAGE_TYPE_CODE) as CoverageTypeCode[];

// ─── PascalCase Soroban variant names ────────────────────────────────────────

/** The PascalCase symbol string sent to the Soroban contract.
 *  Generated directly from COVERAGE_TYPE_CODE so the order can never drift. */
export type CoverageTypeSoroban = keyof typeof COVERAGE_TYPE_CODE;

/**
 * Value object that mirrors the old `CoverageTypeName` enum shape so that
 * call sites using `CoverageTypeName.StablecoinDepeg` as a computed-property
 * key or as an `@IsEnum(CoverageTypeName)` argument continue to work without
 * changes. The underlying values are the PascalCase Soroban variant strings.
 *
 * Use `CoverageTypeSoroban` as the TypeScript type; use `CoverageTypeName`
 * as the runtime value (e.g. for class-validator @IsEnum decorators or
 * as object literal keys).
 */
export const CoverageTypeName = {
  StablecoinDepeg: "StablecoinDepeg",
  MarketCrash: "MarketCrash",
  LiquidationShield: "LiquidationShield",
  SmartContractRisk: "SmartContractRisk",
  FlightDelay: "FlightDelay",
} as const satisfies Record<CoverageTypeSoroban, CoverageTypeSoroban>;

// eslint-disable-next-line @typescript-eslint/no-redeclare
export type CoverageTypeName = (typeof CoverageTypeName)[keyof typeof CoverageTypeName];

// ─── Postgres snake_case enum values ────────────────────────────────────────

/** The snake_case strings stored in the Postgres `coverage_type` column.
 *  Must stay in sync with the CREATE TYPE in src/db/schema.sql. */
export const COVERAGE_TYPE_PG = {
  StablecoinDepeg: "stablecoin_depeg",
  MarketCrash: "market_crash",
  LiquidationShield: "liquidation_shield",
  SmartContractRisk: "smart_contract_risk",
  FlightDelay: "flight_delay",
} as const satisfies Record<CoverageTypeSoroban, string>;

export type CoverageTypePg = (typeof COVERAGE_TYPE_PG)[keyof typeof COVERAGE_TYPE_PG];

// ─── Human-readable labels ───────────────────────────────────────────────────

export const COVERAGE_TYPE_LABEL: Record<CoverageTypeSoroban, string> = {
  StablecoinDepeg: "Stablecoin Depeg",
  MarketCrash: "Market Crash",
  LiquidationShield: "Liquidation Shield",
  SmartContractRisk: "Smart Contract Risk",
  FlightDelay: "Flight Delay",
};

// ─── Risk / pricing parameters ───────────────────────────────────────────────

/** Annualised risk multiplier applied on top of BASE_RATE_BPS. */
export const COVERAGE_TYPE_RISK_MULTIPLIER: Record<CoverageTypeSoroban, number> = {
  StablecoinDepeg: 1.0,
  MarketCrash: 1.5,
  LiquidationShield: 2.0,
  SmartContractRisk: 3.0,
  FlightDelay: 0.8,
};

/**
 * Default trigger threshold per coverage type, in the units the Soroban
 * contract's process_claim() compares against:
 *   - StablecoinDepeg / MarketCrash : basis points (bps)
 *   - LiquidationShield             : bps (inert — triggers on oracle_value > 0)
 *   - SmartContractRisk             : bps (inert — triggers on oracle_value > 0)
 *   - FlightDelay                   : minutes
 */
export const COVERAGE_TYPE_TRIGGER_THRESHOLD: Record<CoverageTypeSoroban, number> = {
  StablecoinDepeg: 500,
  MarketCrash: 3000,
  LiquidationShield: 500,
  SmartContractRisk: 500,
  FlightDelay: 120,
};

// ─── Lookup helpers ───────────────────────────────────────────────────────────

/**
 * Convert a numeric code (0..4) to its PascalCase Soroban variant name.
 * Throws on unknown codes so callers never silently use an undefined name.
 */
export function codeToSoroban(code: number): CoverageTypeSoroban {
  const entry = (Object.entries(COVERAGE_TYPE_CODE) as [CoverageTypeSoroban, number][]).find(
    ([, v]) => v === code
  );
  if (!entry) {
    throw new Error(`Unknown coverage type code: ${code}`);
  }
  return entry[0];
}

/**
 * Convert a numeric code (0..4) to its Postgres enum string.
 * Throws on unknown codes.
 */
export function codeToPg(code: number): CoverageTypePg {
  return COVERAGE_TYPE_PG[codeToSoroban(code)];
}

/**
 * Convert a Postgres enum string to its numeric code.
 * Throws if the value isn't a valid coverage_type.
 */
export function pgToCode(pg: string): CoverageTypeCode {
  const entry = (Object.entries(COVERAGE_TYPE_PG) as [CoverageTypeSoroban, string][]).find(
    ([, v]) => v === pg
  );
  if (!entry) {
    throw new Error(`Unknown Postgres coverage_type: ${pg}`);
  }
  return COVERAGE_TYPE_CODE[entry[0]];
}

/**
 * Type guard — returns true if `n` is a valid CoverageTypeCode (0..4).
 */
export function isValidCoverageTypeCode(n: number): n is CoverageTypeCode {
  return (COVERAGE_TYPE_CODES as number[]).includes(n);
}
