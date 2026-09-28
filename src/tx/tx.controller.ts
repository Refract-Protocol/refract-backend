import { Body, Controller, Post } from "@nestjs/common";
import { SubmitTxDto } from "./dto/submit-tx.dto";
import { FeeBumpDto } from "./dto/fee-bump.dto";
import { TxService } from "./tx.service";

@Controller("api/v1/tx")
export class TxController {
  constructor(private readonly txService: TxService) {}

  @Post("submit")
  submit(@Body() dto: SubmitTxDto) {
    return this.txService.submit(dto.signedXdr);
  }

  @Post("fee-bump")
  feeBump(@Body() dto: FeeBumpDto) {
    return this.txService.feeBump(dto.signedXdr, dto.fee);
  }
}
