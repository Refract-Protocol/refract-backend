import { Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { ClaimService } from "./claim.service";

/**
 * Auto-processes triggered policies every 5 minutes — same cadence as the
 * setInterval loop that used to live in src/index.ts.
 *
 * During graceful shutdown the scheduler stops starting new runs so that
 * in-flight settlements can drain within the configured grace period.
 */
@Injectable()
export class ClaimScheduler implements OnApplicationShutdown {
  private readonly logger = new Logger(ClaimScheduler.name);
  private shuttingDown = false;

  constructor(private readonly claimService: ClaimService) {}

  onApplicationShutdown(): void {
    this.shuttingDown = true;
    this.logger.log("ClaimScheduler shutting down — no new claim runs will start");
  }

  @Interval(300_000)
  async scanAndSettle(): Promise<void> {
    if (this.shuttingDown) {
      this.logger.debug("Skipping claim scan: shutdown in progress");
      return;
    }
    try {
      const processed = await this.claimService.processTriggered();
      if (processed.length > 0) {
        this.logger.log(`Auto-processed ${processed.length} claim(s)`);
      }
    } catch (err) {
      this.logger.error("Claim processor error", err instanceof Error ? err.stack : String(err));
    }
  }
}
