import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { ClaimService } from "./claim.service";

/**
 * Auto-processes triggered policies every 5 minutes — same cadence as the
 * setInterval loop that used to live in src/index.ts.
 *
 * Logs every scan outcome, including all-failed / empty-settlement scans,
 * with counts by error classification.
 */
@Injectable()
export class ClaimScheduler {
  private readonly logger = new Logger(ClaimScheduler.name);

  constructor(private readonly claimService: ClaimService) {}

  @Interval(300_000)
  async scanAndSettle(): Promise<void> {
    try {
      const { settled, counts } = await this.claimService.processTriggeredWithStats();
      this.logger.log(
        `Claim scan complete: scanned=${counts.scanned} triggered=${counts.triggered} ` +
          `settled=${counts.settled} deferred=${counts.deferred} ` +
          `transient=${counts.failedTransient} permanent=${counts.failedPermanent} ` +
          `indeterminate=${counts.failedIndeterminate} deadLettered=${counts.deadLettered}` +
          (settled.length > 0 ? ` (auto-processed ${settled.length} claim(s))` : "")
      );
    } catch (err) {
      this.logger.error("Claim processor error", err instanceof Error ? err.stack : String(err));
    }
  }
}
