import { IsString, Length, Matches } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class WithdrawDto {
  @ApiProperty({ description: "Stellar address of the liquidity provider", minLength: 56, maxLength: 56 })
  @IsString()
  @Length(56, 56)
  provider!: string;

  @ApiProperty({ description: "Pool shares to withdraw in base units", pattern: "^\\d+$" })
  @IsString()
  @Matches(/^\d+$/)
  shares!: string;
}
