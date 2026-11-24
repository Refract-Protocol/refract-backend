import { Expose } from "class-transformer";

export class ClaimStatsResponseDto {
  @Expose()
  activePolicies!: number;

  @Expose()
  processedClaims!: number;

  @Expose()
  totalPayout!: string;
}

export class ClaimStatsOpsResponseDto extends ClaimStatsResponseDto {
  @Expose()
  settlementConfigured!: boolean;

  @Expose()
  deadLetterClaims!: number;

  @Expose()
  settlementRetries!: number;
}
