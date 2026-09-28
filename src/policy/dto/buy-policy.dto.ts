import {
  IsInt,
  IsObject,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidateIf,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";

@ValidatorConstraint({ name: "isBoundedTriggerParams", async: false })
class IsBoundedTriggerParamsConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === undefined) return true;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;

    const entries = Object.entries(value);
    return (
      entries.length <= 8 &&
      entries.every(
        ([key, entry]) =>
          key.length <= 64 &&
          ((typeof entry === "string" && entry.length <= 256) ||
            (typeof entry === "number" && Number.isFinite(entry)) ||
            typeof entry === "boolean")
      )
    );
  }

  defaultMessage(_args: ValidationArguments): string {
    return "triggerParams must contain at most 8 short keys and scalar values (strings up to 256 characters)";
  }
}

export class BuyPolicyDto {
  @IsString()
  @Length(56, 56)
  holder!: string;

  @IsInt()
  @Min(0)
  @Max(4)
  coverageType!: number;

  /** USDC amount in 1e7 base units, passed as a decimal string to avoid precision loss. */
  @IsString()
  @Matches(/^\d+$/)
  @MaxLength(39)
  coverageAmount!: string;

  @IsInt()
  @Min(1)
  @Max(365)
  durationDays!: number;

  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  @Validate(IsBoundedTriggerParamsConstraint)
  triggerParams?: Record<string, unknown>;
}
