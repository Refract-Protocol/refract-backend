import { Body, Controller, Post } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { SubmitTxDto } from "./dto/submit-tx.dto";
import { TxService } from "./tx.service";

@ApiTags("tx")
@Controller("api/v1/tx")
export class TxController {
  constructor(private readonly txService: TxService) {}

  @Post("submit")
  @ApiOperation({
    summary: "Submit a signed Stellar transaction",
    description:
      "Completes the unsigned-XDR flow: build the transaction via the relevant " +
      "endpoint (e.g. POST /api/v1/policy/buy or POST /api/v1/claim), sign the " +
      "returned `txXdr` in the caller's wallet, then submit the signed envelope " +
      "here. The server never holds signing keys; it only relays the signed " +
      "transaction to the network and reports the confirmation result.",
  })
  @ApiBody({ type: SubmitTxDto })
  @ApiOkResponse({
    description:
      "Transaction submitted and confirmed. Returns the transaction hash and " +
      "the ledger in which it was included.",
    schema: {
      type: "object",
      properties: {
        hash: {
          type: "string",
          description: "Stellar transaction hash (hex).",
          example: "3389e9f0f1a65f19736cacf544c2e825313e8447f569233bb8db39aa607c8889",
        },
        ledger: {
          type: "number",
          description: "Ledger sequence number the transaction was included in.",
          example: 1234567,
        },
      },
      required: ["hash", "ledger"],
    },
  })
  @ApiBadRequestResponse({
    description:
      "The signed XDR is malformed, was not signed, or the transaction failed " +
      "validation on the network.",
    schema: {
      type: "object",
      properties: {
        statusCode: { type: "number", example: 400 },
        message: { type: "string", example: "Invalid signed transaction XDR" },
        error: { type: "string", example: "Bad Request" },
      },
      required: ["statusCode", "message"],
    },
  })
  submit(@Body() dto: SubmitTxDto) {
    return this.txService.submit(dto.signedXdr);
  }
}
