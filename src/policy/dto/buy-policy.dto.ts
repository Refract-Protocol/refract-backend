import { IsInt, IsObject, IsOptional, IsString, Length, Matches, Max, Min } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class BuyPolicyDto {
  @ApiProperty({ description: "Stellar address of the policy holder", minLength: 56, maxLength: 56 })
  @IsString()
  @Length(56, 56)
  holder!: string;

  @ApiProperty({ description: "Coverage type identifier", minimum: 0, maximum: 4, example: 0 })
  @IsInt()
  @Min(0)
  @Max(4)
  coverageType!: number;

  /** USDC amount in 1e7 base units, passed as a decimal string to avoid precision loss. */
  @ApiProperty({ description: "Coverage amount in USDC base units (1 USDC = 10^7)", pattern: "^\\d+$" })
  @IsString()
  @Matches(/^\d+$/)
  coverageAmount!: string;

  @ApiProperty({ description: "Policy duration in days", minimum: 1, maximum: 365 })
  @IsInt()
  @Min(1)
  @Max(365)
  durationDays!: number;

  @ApiPropertyOptional({ description: "Coverage-specific trigger parameters", type: "object", additionalProperties: true })
  @IsOptional()
  @IsObject()
  triggerParams?: Record<string, unknown>;
}
