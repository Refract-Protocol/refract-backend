import { IsNotEmpty, IsString, Matches } from "class-validator";

export class FeeBumpDto {
  /** Base64 XDR of the original transaction, signed by its original signer. */
  @IsString()
  @IsNotEmpty()
  signedXdr!: string;

  /** Total fee in stroops for the fee-bumped envelope. */
  @IsString()
  @Matches(/^\d+$/)
  fee!: string;
}
