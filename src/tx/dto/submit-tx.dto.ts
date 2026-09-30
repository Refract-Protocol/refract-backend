import { IsNotEmpty, IsString } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class SubmitTxDto {
  /** Base64 XDR of a transaction envelope already signed by the caller's wallet. */
  @ApiProperty({ description: "Base64 XDR of a transaction envelope signed by the caller", format: "byte" })
  @IsString()
  @IsNotEmpty()
  signedXdr!: string;
}
