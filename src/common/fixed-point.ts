/**
 * Exact 1e7 fixed-point arithmetic for monetary values.
 *
 * CONTRIBUTING.md mandates that money is handled as BigInt in 1e7
 * fixed-point — never as `number`. Every helper here keeps all
 * intermediates as `bigint` and performs a single, explicit rounding
 * step at the very end of a computation.
 *
 * Rounding policy: all divisions round UP (toward positive infinity).
 * Premiums are paid into the pool, so rounding up is the direction
 * favorable to the pool and never under-charges a buyer. The rationale
 * is documented here once and reused everywhere via `divRoundUp`.
 */

/** Number of decimal places in the fixed-point representation. */
export const FIXED_POINT_DECIMALS = 7;

/** 1.0 expressed in 1e7 fixed-point units. */
export const FIXED_POINT_ONE = 10_000_000n;

/** 1.0 expressed in basis points (10000 bps = 100%). */
export const BPS_ONE = 10_000n;

/**
 * Divides two BigInts, rounding the result UP (toward +infinity).
 *
 * This is the single rounding primitive used for money math. Rounding up
 * is deliberately favorable to the pool: a premium can never be rounded
 * down below its exact value, so the pool is never short-changed and a
 * buyer is never under-charged.
 */
export function divRoundUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new RangeError("divRoundUp: denominator must be positive");
  }
  if (numerator < 0n) {
    throw new RangeError("divRoundUp: numerator must be non-negative");
  }
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Multiplies a 1e7 fixed-point amount by a rate expressed in basis
 * points (10000 bps = 1.0x), returning a 1e7 fixed-point result.
 *
 * Multiplication happens before the single division so no precision is
 * lost in an intermediate step.
 */
export function mulByBps(amount: bigint, bps: bigint): bigint {
  return divRoundUp(amount * bps, BPS_ONE);
}

/**
 * Multiplies a 1e7 fixed-point amount by a scaled rate (e.g. 10000 =
 * 1.0x), returning a 1e7 fixed-point result. `scale` is the denominator
 * that the rate is expressed against.
 */
export function mulByScaledRate(amount: bigint, rate: bigint, scale: bigint): bigint {
  return divRoundUp(amount * rate, scale);
}

/**
 * Computes `amount * numerator / denominator` in one shot, multiplying
 * before dividing and rounding up once at the end.
 */
export function mulDivRoundUp(amount: bigint, numerator: bigint, denominator: bigint): bigint {
  return divRoundUp(amount * numerator, denominator);
}

/**
 * Formats a 1e7 fixed-point value as a decimal string with `decimals`
 * places (default 7), truncating any further precision. No floats are
 * involved at any point.
 */
export function formatFixed(value: bigint, decimals = FIXED_POINT_DECIMALS): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / FIXED_POINT_ONE;
  const fraction = abs % FIXED_POINT_ONE;
  const fractionStr = fraction.toString().padStart(FIXED_POINT_DECIMALS, "0");
  const trimmed = decimals >= FIXED_POINT_DECIMALS ? fractionStr : fractionStr.slice(0, decimals);
  const sign = negative ? "-" : "";
  return decimals > 0 ? `${sign}${whole}.${trimmed}` : `${sign}${whole}`;
}

/**
 * Parses a decimal string (e.g. "123.4567891") into a 1e7 fixed-point
 * BigInt, truncating beyond 7 decimal places. Throws on malformed input.
 */
export function parseFixed(value: string): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new RangeError(`parseFixed: invalid decimal string "${value}"`);
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholePart, fractionPart = ""] = unsigned.split(".");
  const paddedFraction = fractionPart.padEnd(FIXED_POINT_DECIMALS, "0").slice(0, FIXED_POINT_DECIMALS);
  const result = BigInt(wholePart) * FIXED_POINT_ONE + BigInt(paddedFraction || "0");
  return negative ? -result : result;
}

/**
 * Formats a 1e7 fixed-point value as a percentage string (e.g. 0.03 ->
 * "3.0000"), truncating to `decimals` places. Used for the quote's
 * premiumRate field without ever touching a float.
 */
export function formatPercent(value: bigint, decimals = 4): string {
  const scaled = value * 100n;
  const whole = scaled / FIXED_POINT_ONE;
  const fraction = scaled % FIXED_POINT_ONE;
  const fractionStr = fraction.toString().padStart(FIXED_POINT_DECIMALS, "0");
  const trimmed = decimals >= FIXED_POINT_DECIMALS ? fractionStr : fractionStr.slice(0, decimals);
  return decimals > 0 ? `${whole}.${trimmed}` : `${whole}`;
}
