import { IsNotEmpty, IsString } from "class-validator";

export class SubmitTxDto {
  /** Base64 XDR of a transaction envelope already signed by the caller's wallet. */
  @IsString()
  @IsNotEmpty()
  signedXdr!: string;
}
