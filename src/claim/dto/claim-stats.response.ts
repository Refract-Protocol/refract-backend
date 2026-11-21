import { ApiProperty } from "@nestjs/swagger";
import { Expose } from "class-transformer";

export class ClaimStatsResponseDto {
  @ApiProperty({ description: "Number of currently active policies", example: 12 })
  @Expose()
  activePolicies!: number;

  @ApiProperty({ description: "Total number of processed claims", example: 340 })
  @Expose()
  processedClaims!: number;

  @ApiProperty({ description: "Sum of all payouts, as a fixed-point string", example: "1250.00" })
  @Expose()
  totalPayout!: string;

  @ApiProperty({ description: "Number of claims parked in the dead-letter queue", example: 0 })
  @Expose()
  deadLetterClaims!: number;

  @ApiProperty({ description: "Total number of settlement retries", example: 3 })
  @Expose()
  settlementRetries!: number;
}

export class ClaimStatsOpsResponseDto extends ClaimStatsResponseDto {
  @ApiProperty({ description: "Whether the relayer settlement path is configured", example: true })
  @Expose()
  settlementConfigured!: boolean;
}
