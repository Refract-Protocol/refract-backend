import { IsString, Length, Matches } from "class-validator";

export class DepositDto {
  @IsString()
  @Length(56, 56)
  provider!: string;

  @IsString()
  @Matches(/^\d+$/)
  amount!: string;
}
