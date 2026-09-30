import { ArrayNotEmpty, ArrayUnique, IsArray, IsEnum, IsInt, IsNumber, IsOptional, Max, Min } from "class-validator";
import { CoverageTypeName } from "../coverage-type";

/**
 * Same amount/duration bounds as CreateQuoteDto. triggerThreshold is left
 * out on purpose: its unit differs per coverage type (bps vs minutes), so
 * one value can't apply across a comparison — each type uses its default.
 */
export class CompareQuotesDto {
  @IsNumber()
  @Min(10)
  @Max(100_000)
  coverageAmount!: number;

  @IsInt()
  @Min(1)
  @Max(365)
  durationDays!: number;

  /** Subset to compare; omit to compare every coverage type. */
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsEnum(CoverageTypeName, { each: true })
  coverageTypes?: CoverageTypeName[];
}
