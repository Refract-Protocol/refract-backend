import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CrossSourceUnitCanonicalizer } from "./unitCanonicalizer.ts";

describe("Unit Canonicalization and Decimal Precision Normalization (#226)", () => {
  it("normalizes heterogeneous decimal precisions and scaled integers into exact canonical minor units with half-up rounding", () => {
    // 1. 18-decimal wei-like USD price rescaled to 8-decimal canonical minor units with half-up rounding
    const from18Dec = CrossSourceUnitCanonicalizer.normalizeReading({
      feedKind: "price_usd",
      declaredSourceUnit: "usd_scaled_int",
      rawValue: "1000500005000000000", // 1.000500005 -> rounds half-up to 1.00050001
      sourceDecimals: 18,
    });
    assert.equal(from18Dec.canonicalMinorUnits, 100_050_001n);
    assert.equal(from18Dec.formattedDecimal, "1.00050001");

    // 2. Idempotency: re-normalizing the formatted canonical output produces the exact same minor units
    const idempotent = CrossSourceUnitCanonicalizer.normalizeReading({
      feedKind: "price_usd",
      declaredSourceUnit: "usd_decimal_string",
      rawValue: from18Dec.formattedDecimal,
    });
    assert.equal(idempotent.canonicalMinorUnits, from18Dec.canonicalMinorUnits);

    // 3. Duration conversions to integer delay_minutes
    const fromSeconds = CrossSourceUnitCanonicalizer.normalizeReading({
      feedKind: "delay_minutes",
      declaredSourceUnit: "duration_seconds",
      rawValue: "7530", // 125.5 minutes -> rounds half-up to 126
    });
    assert.equal(fromSeconds.canonicalMinorUnits, 126n);
  });

  it("rejects missing or mismatched declared units and non-finite/negative readings at normalization", () => {
    assert.throws(
      () =>
        CrossSourceUnitCanonicalizer.normalizeReading({
          feedKind: "price_usd",
          declaredSourceUnit: undefined,
          rawValue: "1.00",
        }),
      /MISSING_DECLARED_UNIT/
    );

    assert.throws(
      () =>
        CrossSourceUnitCanonicalizer.normalizeReading({
          feedKind: "price_usd",
          declaredSourceUnit: "duration_minutes",
          rawValue: "100",
        }),
      /MISMATCHED_DECLARED_UNIT/
    );

    assert.throws(
      () =>
        CrossSourceUnitCanonicalizer.normalizeReading({
          feedKind: "price_usd",
          declaredSourceUnit: "usd_decimal_string",
          rawValue: "-0.99",
        }),
      /INVALID_OR_NON_FINITE_READING/
    );
  });
});
