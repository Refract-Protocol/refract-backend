import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";
import { CoverageTypeName } from "../../quote/coverage-type";
import { getCoverageType } from "../coverage-catalog";

/**
 * Per-coverage-type duration and amount limits.
 *
 * The coverage catalog advertises different bounds per product (e.g. Flight
 * Delay is capped at 1 day / 2,000 USDC while Liquidation Shield allows 30
 * days / 200,000 USDC), so a flat `@Max` cannot express them. This constraint
 * runs on the whole DTO object and reads the sibling `coverageType`,
 * `durationDays` and `coverageAmount` properties.
 *
 * Unit note: `CreateQuoteDto.coverageAmount` is a plain number in whole USDC,
 * while `BuyPolicyDto.coverageAmount` is a 1e7 base-unit decimal string. The
 * validator normalises both to whole USDC before comparing against the
 * catalog limits.
 */
const BASE_UNIT_DECIMALS = 7;
const BASE_UNIT_FACTOR = 10 ** BASE_UNIT_DECIMALS;

function toWholeUsdc(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    // Base-unit decimal string (e.g. "20000000000" for 2,000 USDC).
    if (/^\d+$/.test(trimmed)) {
      return Number(trimmed) / BASE_UNIT_FACTOR;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

@ValidatorConstraint({ name: "coverageLimits", async: false })
export class CoverageLimitsConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const object = args.object as Record<string, unknown>;
    const coverageType = object.coverageType as CoverageTypeName | undefined;

    // Unknown coverage types are reported by the @IsEnum constraint; skip here
    // so the caller sees the enum error rather than a confusing limits error.
    if (!coverageType || !Object.values(CoverageTypeName).includes(coverageType)) {
      return true;
    }

    const limits = getCoverageType(coverageType);
    if (!limits) {
      return true;
    }

    const durationDays = object.durationDays;
    if (typeof durationDays === "number" && Number.isFinite(durationDays)) {
      if (durationDays < limits.minDurationDays || durationDays > limits.maxDurationDays) {
        return false;
      }
    }

    const coverageAmount = toWholeUsdc(object.coverageAmount);
    if (coverageAmount !== undefined) {
      if (coverageAmount < limits.minCoverageAmount || coverageAmount > limits.maxCoverageAmount) {
        return false;
      }
    }

    return true;
  }

  defaultMessage(args: ValidationArguments): string {
    const object = args.object as Record<string, unknown>;
    const coverageType = object.coverageType as CoverageTypeName | undefined;
    const limits = coverageType ? getCoverageType(coverageType) : undefined;

    if (!limits) {
      return "coverageAmount or durationDays is outside the allowed range for this coverage type";
    }

    const durationDays = object.durationDays;
    if (typeof durationDays === "number" && Number.isFinite(durationDays)) {
      if (durationDays < limits.minDurationDays || durationDays > limits.maxDurationDays) {
        return `durationDays for ${coverageType} must be between ${limits.minDurationDays} and ${limits.maxDurationDays} days (maxDuration: ${limits.maxDurationDays})`;
      }
    }

    const coverageAmount = toWholeUsdc(object.coverageAmount);
    if (coverageAmount !== undefined) {
      if (coverageAmount < limits.minCoverageAmount || coverageAmount > limits.maxCoverageAmount) {
        return `coverageAmount for ${coverageType} must be between ${limits.minCoverageAmount} and ${limits.maxCoverageAmount} USDC (maxCoverage: ${limits.maxCoverageAmount})`;
      }
    }

    return "coverageAmount or durationDays is outside the allowed range for this coverage type";
  }
}

export function IsWithinCoverageLimits(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: "coverageLimits",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: CoverageLimitsConstraint,
    });
  };
}
