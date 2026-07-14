import { IsInt, IsObject, IsOptional, IsString, Length, Matches, Max, Min } from "class-validator";

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
  coverageAmount!: string;

  @IsInt()
  @Min(1)
  @Max(365)
  durationDays!: number;

  @IsOptional()
  @IsObject()
  triggerParams?: Record<string, unknown>;
}
