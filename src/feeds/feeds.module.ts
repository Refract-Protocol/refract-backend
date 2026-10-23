import { Module } from "@nestjs/common";
import { FeedDefinitionsService } from "./feed-definitions.service";
import { FeedsController } from "./feeds.controller";

@Module({
  controllers: [FeedsController],
  providers: [FeedDefinitionsService],
  exports: [FeedDefinitionsService],
})
export class FeedsModule {}
