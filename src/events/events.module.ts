import { Module } from "@nestjs/common";
import { PoolEventIngestionService } from "./pool-event-ingestion.service";

@Module({
  providers: [PoolEventIngestionService],
})
export class EventsModule {}
