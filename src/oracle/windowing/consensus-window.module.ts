import { Module } from "@nestjs/common";
import { ConsensusWindowRepository } from "./consensus-window.repository";
import { ConsensusWindowService } from "./consensus-window.service";
import { DbModule } from "../../db/db.module";
import { DEFAULT_FEED_WINDOW_CONFIGS } from "./window-config";

@Module({
  imports: [DbModule],
  providers: [
    ConsensusWindowRepository,
    {
      provide: ConsensusWindowService,
      useFactory: (repo: ConsensusWindowRepository) =>
        new ConsensusWindowService(repo, DEFAULT_FEED_WINDOW_CONFIGS),
      inject: [ConsensusWindowRepository],
    },
  ],
  exports: [ConsensusWindowService, ConsensusWindowRepository],
})
export class ConsensusWindowModule {}
