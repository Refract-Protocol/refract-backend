import { Body, Controller, Post } from "@nestjs/common";
import { SubmitTxDto } from "./dto/submit-tx.dto";
import { TxService } from "./tx.service";
import { SecurityAudit } from "../common/security-audit.interceptor";

@Controller("api/v1/tx")
export class TxController {
  constructor(private readonly txService: TxService) {}

  @Post("submit")
  @SecurityAudit("tx.submit")
  submit(@Body() dto: SubmitTxDto) {
    return this.txService.submit(dto.signedXdr);
  }
}
