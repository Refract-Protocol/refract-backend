import { IsString, Length, Matches } from "class-validator";

export class WithdrawDto {
  @IsString()
  @Length(56, 56)
  provider!: string;

  @IsString()
  @Matches(/^\d+$/)
  shares!: string;
}
