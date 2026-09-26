import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsObject, IsOptional, IsString, Length, Matches, Max, Min } from "class-validator";

export class BuyPolicyDto {
  @ApiProperty({
    description: "Stellar account (G...) that will hold the policy.",
    example: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    minLength: 56,
    maxLength: 56,
  })
  @IsString()
  @Length(56, 56)
  holder!: string;

  @ApiProperty({
    description: "Coverage type identifier (0-4).",
    example: 0,
    minimum: 0,
    maximum: 4,
  })
  @IsInt()
  @Min(0)
  @Max(4)
  coverageType!: number;

  /** USDC amount in 1e7 base units, passed as a decimal string to avoid precision loss. */
  @ApiProperty({
    description:
      "USDC amount in 1e7 base units, passed as a decimal string to avoid precision loss.",
    example: "1000000000",
    type: String,
    pattern: "^\\d+$",
  })
  @IsString()
  @Matches(/^\d+$/)
  coverageAmount!: string;

  @ApiProperty({
    description: "Policy duration in days.",
    example: 30,
    minimum: 1,
    maximum: 365,
  })
  @IsInt()
  @Min(1)
  @Max(365)
  durationDays!: number;

  @ApiPropertyOptional({
    description:
      "Coverage-type-specific trigger parameters. Units of triggerThreshold vary per coverage type.",
    type: Object,
    example: { triggerThreshold: "500000000" },
  })
  @IsOptional()
  @IsObject()
  triggerParams?: Record<string, unknown>;
}
