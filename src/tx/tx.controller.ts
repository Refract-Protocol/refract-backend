import { Body, Controller, Post } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { SubmitTxDto } from "./dto/submit-tx.dto";
import { TxService } from "./tx.service";

@ApiTags("Transactions")
@Controller("api/v1/tx")
export class TxController {
  constructor(private readonly txService: TxService) {}

  @Post("submit")
  @ApiOperation({ summary: "Submit a transaction signed by the caller" })
  @ApiResponse({ status: 201, description: "Transaction confirmation result" })
  @ApiResponse({ status: 400, description: "Malformed signed transaction XDR" })
  submit(@Body() dto: SubmitTxDto) {
    return this.txService.submit(dto.signedXdr);
  }
}
