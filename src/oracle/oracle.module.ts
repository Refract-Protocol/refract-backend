import { Module } from "@nestjs/common";
import { OracleController } from "./oracle.controller";
import { OracleGateway } from "./oracle.gateway";
import { OracleScheduler } from "./oracle.scheduler";
import { OracleService } from "./oracle.service";

@Module({
  controllers: [OracleController],
  providers: [OracleService, OracleGateway, OracleScheduler],
  exports: [OracleService, OracleGateway],
})
export class OracleModule {}
