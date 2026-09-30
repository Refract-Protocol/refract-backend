import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";

/**
 * Hand-built ScVal encoders for Soroban #[contracttype] values.
 *
 * These mirror soroban-sdk's derive macros exactly:
 *  - structs → Map<Symbol, Val> with entries sorted by field name
 *    (soroban-sdk-macros::derive_struct sorted_by_key)
 *  - unit-variant enums → one-element Vec holding the variant Symbol
 *    (soroban-sdk-macros::derive_enum map_empty_variant)
 *
 * Golden XDR fixtures in `xdr-fixtures/` pin the byte encoding. A fixture
 * mismatch means either the contract ABI changed or this encoding regressed —
 * check both before regenerating (see scripts/regenerate-xdr-fixtures.ts).
 *
 * Symbol names are capped at 32 characters in Soroban; all field/variant
 * names below are asserted to fit.
 */

/** Mirrors refract-contracts CoverageType enum declaration order. */
export const COVERAGE_TYPE_VARIANTS = [
  "StablecoinDepeg",
  "MarketCrash",
  "LiquidationShield",
  "SmartContractRisk",
  "FlightDelay",
] as const;

/**
 * trigger_threshold per coverage type, in the units process_claim() compares
 * against: bps for StablecoinDepeg/MarketCrash, minutes for FlightDelay.
 * LiquidationShield/SmartContractRisk trigger on `oracle_value > 0` and never
 * read trigger_threshold — kept non-zero only for consistency.
 */
export const TRIGGER_THRESHOLDS = [500, 3000, 500, 500, 120] as const;

export type TriggerThresholdUnit = "bps" | "minutes" | "inert";

export const TRIGGER_THRESHOLD_UNITS: readonly TriggerThresholdUnit[] = [
  "bps",
  "bps",
  "inert",
  "inert",
  "minutes",
] as const;

const POLICY_PARAMS_FIELD_NAMES = [
  "coverage_amount",
  "coverage_type",
  "duration_days",
  "trigger_threshold",
] as const;

const MAX_SOROBAN_SYMBOL_LEN = 32;

function assertSymbolFits(name: string): void {
  if (name.length > MAX_SOROBAN_SYMBOL_LEN) {
    throw new Error(`Soroban Symbol "${name}" exceeds ${MAX_SOROBAN_SYMBOL_LEN}-char limit`);
  }
}

for (const name of POLICY_PARAMS_FIELD_NAMES) assertSymbolFits(name);
for (const name of COVERAGE_TYPE_VARIANTS) assertSymbolFits(name);

export interface PolicyParamsInput {
  coverageType: number;
  coverageAmount: bigint;
  durationDays: number;
  triggerThreshold: number;
}

/**
 * Encodes PolicyParams as an scvMap with keys in alphabetical order —
 * coverage_amount, coverage_type, duration_days, trigger_threshold.
 */
export function buildPolicyParamsScVal(params: PolicyParamsInput): xdr.ScVal {
  const { coverageType, coverageAmount, durationDays, triggerThreshold } = params;
  if (coverageType < 0 || coverageType >= COVERAGE_TYPE_VARIANTS.length) {
    throw new Error(`Invalid coverageType ${coverageType}`);
  }

  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("coverage_amount"),
      val: nativeToScVal(coverageAmount, { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("coverage_type"),
      val: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(COVERAGE_TYPE_VARIANTS[coverageType])]),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("duration_days"),
      val: nativeToScVal(durationDays, { type: "u32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("trigger_threshold"),
      val: nativeToScVal(BigInt(triggerThreshold), { type: "i128" }),
    }),
  ]);
}

/**
 * process_claim(env, policy_id: u64) — single u64 argument matching
 * refract-contracts/pool/src/lib.rs.
 */
export function encodeProcessClaimArg(policyId: bigint): xdr.ScVal {
  return nativeToScVal(policyId, { type: "u64" });
}

/** provide_capital(provider: Address, amount: i128) */
export function encodeProvideCapitalArgs(provider: string, amount: bigint): xdr.ScVal[] {
  return [new Address(provider).toScVal(), nativeToScVal(amount, { type: "i128" })];
}

/** withdraw_capital(provider: Address, shares: i128) */
export function encodeWithdrawCapitalArgs(provider: string, shares: bigint): xdr.ScVal[] {
  return [new Address(provider).toScVal(), nativeToScVal(shares, { type: "i128" })];
}

/**
 * RefractOracle.publish(feed_id: Symbol, value: i128, timestamp: u64) —
 * the hand-built oracle publish invocation used by the relayer.
 */
export function encodeOraclePublishArgs(feedId: string, value: bigint, timestamp: bigint): xdr.ScVal[] {
  assertSymbolFits(feedId);
  return [
    xdr.ScVal.scvSymbol(feedId),
    nativeToScVal(value, { type: "i128" }),
    nativeToScVal(timestamp, { type: "u64" }),
  ];
}

/** Deliberately-wrong encoding that omits `{ type }` — proves the suite fails loudly. */
export function buildPolicyParamsScValInferred(params: PolicyParamsInput): xdr.ScVal {
  const { coverageType, coverageAmount, durationDays, triggerThreshold } = params;
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("coverage_amount"),
      // nativeToScVal without { type } is the footgun: BigInt above 2^53 and
      // number-typed fields get the wrong discriminant.
      val: nativeToScVal(Number(coverageAmount)),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("coverage_type"),
      val: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(COVERAGE_TYPE_VARIANTS[coverageType])]),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("duration_days"),
      val: nativeToScVal(durationDays),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("trigger_threshold"),
      val: nativeToScVal(triggerThreshold),
    }),
  ]);
}

export function policyParamsToXdrBase64(params: PolicyParamsInput): string {
  return buildPolicyParamsScVal(params).toXDR("base64");
}

export const FIXTURE_MISMATCH_HINT =
  "Golden XDR mismatch: either the contract ABI changed or the ScVal encoding " +
  "regressed. Diff against src/stellar/xdr-fixtures/, then either fix the encoder " +
  "or regenerate with `npx ts-node scripts/regenerate-xdr-fixtures.ts` after " +
  "confirming the ABI change is intentional.";
