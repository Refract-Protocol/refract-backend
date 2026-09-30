import { Module } from "@nestjs/common";
import { OracleController } from "./oracle.controller";
import { OracleGateway } from "./oracle.gateway";
import { OraclePublisherService } from "./oracle-publisher.service";
import { OracleScheduler } from "./oracle.scheduler";
import { OracleService } from "./oracle.service";

@Module({
  controllers: [OracleController],
  providers: [OracleService, OracleGateway, OracleScheduler, OraclePublisherService],
  exports: [OracleService, OracleGateway, OraclePublisherService],
})
export class OracleModule {}
