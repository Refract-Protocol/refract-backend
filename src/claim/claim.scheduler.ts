import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { ClaimService } from "./claim.service";

/**
 * Auto-processes triggered policies every 5 minutes — same cadence as the
 * setInterval loop that used to live in src/index.ts.
 */
@Injectable()
export class ClaimScheduler {
  private readonly logger = new Logger(ClaimScheduler.name);

  constructor(private readonly claimService: ClaimService) {}

  @Interval(300_000)
  async scanAndSettle(): Promise<void> {
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
