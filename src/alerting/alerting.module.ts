import { Module } from "@nestjs/common";
import { AlertingService } from "./alerting.service";

@Module({
  providers: [AlertingService],
  exports: [AlertingService],
})
export class AlertingModule {}
