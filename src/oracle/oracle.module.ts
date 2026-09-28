import { Module } from "@nestjs/common";
import { OracleEventRepository } from "./oracle-event.repository";
import { OracleController } from "./oracle.controller";
import { OracleGateway } from "./oracle.gateway";
import { OracleScheduler } from "./oracle.scheduler";
import { OracleService } from "./oracle.service";

@Module({
  controllers: [OracleController],
  providers: [OracleService, OracleGateway, OracleScheduler, OracleEventRepository],
  exports: [OracleService, OracleGateway, OracleEventRepository],
})
export class OracleModule {}
