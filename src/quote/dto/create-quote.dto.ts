import { IsEnum, IsInt, IsNumber, IsOptional, Max, Min } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { CoverageTypeName } from "../coverage-type";

export class CreateQuoteDto {
  @ApiProperty({ enum: CoverageTypeName, enumName: "CoverageTypeName" })
  @IsEnum(CoverageTypeName)
  coverageType!: CoverageTypeName;

  @ApiProperty({ description: "Coverage amount in USDC", minimum: 10, maximum: 100_000 })
  @IsNumber()
  @Min(10)
  @Max(100_000)
  coverageAmount!: number;

  @ApiProperty({ description: "Policy duration in days", minimum: 1, maximum: 365 })
  @IsInt()
  @Min(1)
  @Max(365)
  durationDays!: number;

  @ApiPropertyOptional({ description: "Coverage trigger threshold" })
  @IsOptional()
  @IsNumber()
  triggerThreshold?: number;
}
