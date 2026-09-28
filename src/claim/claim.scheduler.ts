import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { ClaimService } from "./claim.service";
import { MetricsService } from "../metrics/metrics.service";

/**
 * Auto-processes triggered policies every 5 minutes — same cadence as the
 * setInterval loop that used to live in src/index.ts.
 */
@Injectable()
export class ClaimScheduler {
  private readonly logger = new Logger(ClaimScheduler.name);

  constructor(
    private readonly claimService: ClaimService,
    private readonly metricsService: MetricsService
  ) {}

  @Interval(300_000)
  async scanAndSettle(): Promise<void> {
    const startedAt = process.hrtime.bigint();
    let outcome: "success" | "failure" = "success";
    try {
      const processed = await this.claimService.processTriggered();
      if (processed.length > 0) {
        this.logger.log(`Auto-processed ${processed.length} claim(s)`);
      }
    } catch (err) {
      outcome = "failure";
      this.logger.error("Claim processor error", err instanceof Error ? err.stack : String(err));
    } finally {
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      this.metricsService.recordSchedulerRun("claim_settlement", outcome, durationSeconds);
    }
  }
}
