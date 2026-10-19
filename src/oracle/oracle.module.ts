import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { OracleControlService } from "./control";
import { OracleController } from "./oracle.controller";

@Module({
  imports: [DatabaseModule],
  controllers: [OracleController],
  providers: [OracleControlService],
  exports: [OracleControlService],
})
export class OracleModule {}
