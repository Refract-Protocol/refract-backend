import { IsString, Length, Matches, MaxLength } from "class-validator";

export class WithdrawDto {
  @IsString()
  @Length(56, 56)
  provider!: string;

  @IsString()
  @Matches(/^\d+$/)
  @MaxLength(39)
  shares!: string;
}
