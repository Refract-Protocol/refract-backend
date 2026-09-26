import { IsEnum, IsInt, IsNumberString, IsOptional, Min } from "class-validator";
import { IsWithinCoverageLimits } from "../../common/validators/coverage-limits.validator";
import { CoverageTypeName } from "../../quote/coverage-type";

@IsWithinCoverageLimits()
export class BuyPolicyDto {
  @IsEnum(CoverageTypeName)
  coverageType!: CoverageTypeName;

  @IsNumberString()
  coverageAmount!: string;

  @IsInt()
  @Min(1)
  durationDays!: number;

  @IsOptional()
  @IsNumberString()
  triggerThreshold?: string;
}
