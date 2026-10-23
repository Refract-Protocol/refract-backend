import { Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { OracleQuorumOpsController, OracleRegionsController } from "./oracle-regions.controller";
import { RegionalQuorumAggregator, regionsFromEnv } from "./regional-quorum.aggregator";

const QUORUM_SWEEP_INTERVAL_MS = 30_000;

/**
 * Re-evaluates every feed on a timer. Without it, a region (or all of them)
 * going silent would never change a verdict, because verdicts are otherwise
 * only recomputed when a report arrives.
 */
@Injectable()
export class RegionalQuorumSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RegionalQuorumSweeper.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly aggregator: RegionalQuorumAggregator) {}

  onModuleInit(): void {
    const status = this.aggregator.quorumStatus();
    if (status.warning && status.registeredRegions > 0) this.logger.warn(status.warning);
    this.aggregator.onTrustTransition((t) => {
      const correlated = t.verdict.correlatedFailures.map((c) => `${c.dimension}=${c.value}[${c.regions.join(",")}]`).join("; ");
      const line = `Feed ${t.feedId} trust ${t.from ?? "none"} -> ${t.to}${correlated ? ` correlated: ${correlated}` : ""}`;
      if (t.to === "trusted") this.logger.log(line);
      else this.logger.warn(line);
    });
    this.timer = setInterval(() => {
      this.aggregator.evaluateAll(Date.now()).catch((err) => this.logger.error(`Quorum sweep failed: ${(err as Error).message}`));
    }, QUORUM_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

@Module({
  controllers: [OracleRegionsController, OracleQuorumOpsController],
  providers: [
    {
      provide: RegionalQuorumAggregator,
      useFactory: () => {
        const aggregator = new RegionalQuorumAggregator();
        for (const region of regionsFromEnv(process.env.ORACLE_REGIONS)) aggregator.registerRegion(region);
        return aggregator;
      },
    },
    RegionalQuorumSweeper,
  ],
  exports: [RegionalQuorumAggregator],
})
export class OracleRegionsModule {}
