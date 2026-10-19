import { Module } from "@nestjs/common";
import { OracleController } from "./oracle.controller";
import { OracleEventRepository } from "./oracle-event.repository";
import { OracleStatusService } from "./oracle-status.service";

@Module({
  controllers: [OracleController],
  providers: [OracleStatusService, OracleEventRepository],
  exports: [OracleStatusService, OracleEventRepository],
})
export class OracleModule {}
