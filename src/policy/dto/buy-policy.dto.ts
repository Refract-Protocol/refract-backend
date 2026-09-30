import { IsString, IsNotEmpty, IsOptional, IsNumber, Min } from 'class-validator';
import { IsStellarPublicKey } from '../../common/validators/stellar-address.validator';

export class BuyPolicyDto {
  @IsString()
  @IsNotEmpty()
  @IsStellarPublicKey()
  holder: string;

  @IsString()
  @IsNotEmpty()
  policyId: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  premium?: number;
}

/**
 * Request body for the read-only policy purchase preflight.
 *
 * Mirrors the fields `BuyPolicyDto` needs to evaluate every contract-enforced
 * condition (capacity, utilization, coverage bounds, duration, premium balance)
 * without building or returning an XDR.
 */
export class PreflightPolicyDto {
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
