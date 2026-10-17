export type CanonicalFeedKind = "price_usd" | "tvl_usd" | "delay_minutes";

export type DeclaredSourceUnit =
  | "usd_decimal_string"
  | "usd_scaled_int"
  | "duration_seconds"
  | "duration_minutes"
  | "duration_hours";

export interface CanonicalNormalizedReading {
  feedKind: CanonicalFeedKind;
  canonicalDecimals: number;
  canonicalMinorUnits: bigint;
  formattedDecimal: string;
}

const CANONICAL_DECIMALS: Record<CanonicalFeedKind, number> = {
  price_usd: 8,
  tvl_usd: 2,
  delay_minutes: 0,
};

const ALLOWED_UNITS_BY_KIND: Record<CanonicalFeedKind, DeclaredSourceUnit[]> = {
  price_usd: ["usd_decimal_string", "usd_scaled_int"],
  tvl_usd: ["usd_decimal_string", "usd_scaled_int"],
  delay_minutes: ["duration_seconds", "duration_minutes", "duration_hours"],
};

export class CrossSourceUnitCanonicalizer {
  public static normalizeReading(params: {
    feedKind: CanonicalFeedKind;
    declaredSourceUnit: DeclaredSourceUnit | undefined;
    rawValue: string | number;
    sourceDecimals?: number;
  }): CanonicalNormalizedReading {
    if (!params.declaredSourceUnit) {
      throw new Error("MISSING_DECLARED_UNIT: Adapter must declare a sourceUnit");
    }

    const allowed = ALLOWED_UNITS_BY_KIND[params.feedKind];
    if (!allowed || !allowed.includes(params.declaredSourceUnit)) {
      throw new Error(
        `MISMATCHED_DECLARED_UNIT: Unit ${params.declaredSourceUnit} is incompatible with feedKind ${params.feedKind}`
      );
    }

    const rawStr =
      typeof params.rawValue === "number"
        ? Number.isFinite(params.rawValue)
          ? params.rawValue.toString()
          : "NaN"
        : String(params.rawValue).trim();

    if (!/^[+]?\d+(\.\d+)?$/.test(rawStr)) {
      throw new Error(
        `INVALID_OR_NON_FINITE_READING: Value "${rawStr}" must be a non-negative finite decimal or integer`
      );
    }

    const targetDecimals = CANONICAL_DECIMALS[params.feedKind];
    let canonicalMinorUnits: bigint;

    if (params.feedKind === "delay_minutes") {
      canonicalMinorUnits = this.normalizeDurationToMinutes(
        rawStr,
        params.declaredSourceUnit
      );
    } else if (params.declaredSourceUnit === "usd_scaled_int") {
      if (rawStr.includes(".")) {
        throw new Error(
          "INVALID_SCALED_INT: usd_scaled_int requires an integer mantissa"
        );
      }
      const srcDec = params.sourceDecimals ?? targetDecimals;
      if (!Number.isInteger(srcDec) || srcDec < 0 || srcDec > 36) {
        throw new Error("INVALID_SOURCE_DECIMALS");
      }
      canonicalMinorUnits = this.rescaleBigIntHalfUp(
        BigInt(rawStr),
        srcDec,
        targetDecimals
      );
    } else {
      canonicalMinorUnits = this.parseDecimalStringHalfUp(
        rawStr,
        targetDecimals
      );
    }

    if (params.feedKind === "price_usd" && canonicalMinorUnits <= 0n) {
      throw new Error(
        "OUT_OF_RANGE_READING: price_usd must be strictly positive"
      );
    }

    return {
      feedKind: params.feedKind,
      canonicalDecimals: targetDecimals,
      canonicalMinorUnits,
      formattedDecimal: this.formatMinorUnits(
        canonicalMinorUnits,
        targetDecimals
      ),
    };
  }

  private static normalizeDurationToMinutes(
    rawStr: string,
    unit: DeclaredSourceUnit
  ): bigint {
    // Parse with 4 internal decimals first, then convert to integer minutes with half-up rounding
    const scaled4 = this.parseDecimalStringHalfUp(rawStr, 4);
    if (unit === "duration_seconds") {
      // minutes = seconds / 60 -> divide scaled4 by 600_000 with half-up
      return (scaled4 + 300_000n) / 600_000n;
    }
    if (unit === "duration_hours") {
      // minutes = hours * 60
      return (scaled4 * 60n + 5_000n) / 10_000n;
    }
    return (scaled4 + 5_000n) / 10_000n;
  }

  private static parseDecimalStringHalfUp(
    decimalStr: string,
    targetDecimals: number
  ): bigint {
    const clean = decimalStr.replace(/^\+/, "");
    const [wholePart = "0", fracPart = ""] = clean.split(".");
    const combinedStr = wholePart + fracPart;
    const rawBig = BigInt(combinedStr);
    return this.rescaleBigIntHalfUp(rawBig, fracPart.length, targetDecimals);
  }

  private static rescaleBigIntHalfUp(
    value: bigint,
    fromDecimals: number,
    toDecimals: number
  ): bigint {
    if (fromDecimals === toDecimals) return value;
    if (fromDecimals < toDecimals) {
      const factor = 10n ** BigInt(toDecimals - fromDecimals);
      return value * factor;
    }
    const diff = fromDecimals - toDecimals;
    const divisor = 10n ** BigInt(diff);
    const half = divisor / 2n;
    return (value + half) / divisor;
  }

  public static formatMinorUnits(
    minorUnits: bigint,
    decimals: number
  ): string {
    if (decimals === 0) return minorUnits.toString();
    const s = minorUnits.toString().padStart(decimals + 1, "0");
    const splitIdx = s.length - decimals;
    return `${s.slice(0, splitIdx)}.${s.slice(splitIdx)}`;
  }
}
