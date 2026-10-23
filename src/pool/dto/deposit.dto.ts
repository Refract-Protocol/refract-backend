import { IsString, Length, Matches } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class DepositDto {
  @ApiProperty({ description: "Stellar address of the liquidity provider", minLength: 56, maxLength: 56 })
  @IsString()
  @Length(56, 56)
  provider!: string;

  @ApiProperty({ description: "Deposit amount in USDC base units (1 USDC = 10^7)", pattern: "^\\d+$" })
  @IsString()
  @Matches(/^\d+$/)
  amount!: string;
}
