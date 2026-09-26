import { Module } from "@nestjs/common";
import { StellarModule } from "../stellar/stellar.module";
import { TxController } from "./tx.controller";
import { TxService } from "./tx.service";

@Module({
  imports: [StellarModule],
  controllers: [TxController],
  providers: [TxService],
})
export class TxModule {}
