import { ApiProperty } from "@nestjs/swagger";
import { Expose } from "class-transformer";

export class ClaimStatsResponseDto {
  @ApiProperty({ description: "Number of policies currently active and eligible for a claim." })
  @Expose()
  activePolicies!: number;

  @ApiProperty({ description: "Total number of claims processed since the service started." })
  @Expose()
  processedClaims!: number;

  @ApiProperty({ description: "Sum of all claim payouts in base units (1 USDC = 10^7), as a decimal string." })
  @Expose()
  totalPayout!: string;
}

export class ClaimStatsOpsResponseDto extends ClaimStatsResponseDto {
  @ApiProperty({ description: "Whether the claim settlement relayer is configured and able to submit payouts." })
  @Expose()
  settlementConfigured!: boolean;
}
