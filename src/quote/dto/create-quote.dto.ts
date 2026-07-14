import { IsEnum, IsInt, IsNumber, IsOptional, Max, Min } from "class-validator";
import { CoverageTypeName } from "../coverage-type";

export class CreateQuoteDto {
  @IsEnum(CoverageTypeName)
  coverageType!: CoverageTypeName;

  @IsNumber()
  @Min(10)
  @Max(100_000)
  coverageAmount!: number;

  @IsInt()
  @Min(1)
  @Max(365)
  durationDays!: number;

  @IsOptional()
  @IsNumber()
  triggerThreshold?: number;
}
