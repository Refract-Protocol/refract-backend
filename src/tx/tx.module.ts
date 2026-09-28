import { Module } from "@nestjs/common";
import { PolicyModule } from "../policy/policy.module";
import { TxController } from "./tx.controller";
import { TxService } from "./tx.service";

@Module({
  imports: [PolicyModule],
  controllers: [TxController],
  providers: [TxService],
})
export class TxModule {}
