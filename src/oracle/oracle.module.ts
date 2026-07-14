import { Module } from "@nestjs/common";
import { OracleGateway } from "./oracle.gateway";
import { OracleScheduler } from "./oracle.scheduler";
import { OracleService } from "./oracle.service";

@Module({
  providers: [OracleService, OracleGateway, OracleScheduler],
  exports: [OracleService, OracleGateway],
})
export class OracleModule {}
