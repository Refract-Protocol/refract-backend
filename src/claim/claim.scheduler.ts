import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ClaimService } from './claim.service';

/**
 * Upper bound (ms) we are willing to wait for an in-flight settlement run to
 * finish before letting the process shut down. Kept in sync with the
 * bootstrap-level shutdown grace period so a stuck settlement cannot block
 * SIGTERM handling indefinitely.
 */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000;

@Injectable()
export class ClaimScheduler implements OnApplicationShutdown {
  private readonly logger = new Logger(ClaimScheduler.name);

  /**
   * Tracks the currently executing settlement run so shutdown can wait for it
   * to complete instead of interrupting a mid-flight Soroban settlement.
   */
  private inFlight: Promise<void> | null = null;

  /**
   * Set once shutdown has begun so no new settlement runs are started while
   * the current one drains.
   */
  private shuttingDown = false;

  constructor(private readonly claimService: ClaimService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleClaimSettlement(): Promise<void> {
    if (this.shuttingDown) {
      this.logger.log(
        'Skipping claim settlement run: scheduler is shutting down.',
      );
      return;
    }

    if (this.inFlight) {
      this.logger.warn(
        'Skipping claim settlement run: a previous run is still in flight.',
      );
      return;
    }

    const run = this.runSettlement();
    this.inFlight = run;

    try {
      await run;
    } finally {
      if (this.inFlight === run) {
        this.inFlight = null;
      }
    }
  }

  private async runSettlement(): Promise<void> {
    try {
      await this.claimService.settleClaims();
    } catch (error) {
      this.logger.error(
        'Claim settlement run failed.',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Called by Nest during graceful shutdown. Stops new runs from starting and
   * waits (bounded) for the current settlement run to finish so we never
   * interrupt a mid-flight settlement.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    this.shuttingDown = true;

    if (!this.inFlight) {
      this.logger.log(
        `ClaimScheduler shutdown (${signal ?? 'unknown'}): no in-flight settlement run.`,
      );
      return;
    }

    this.logger.log(
      `ClaimScheduler shutdown (${signal ?? 'unknown'}): waiting up to ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms for in-flight settlement run to finish.`,
    );

    const drained = await this.waitForInFlight();

    if (drained) {
      this.logger.log('In-flight settlement run completed cleanly.');
    } else {
      this.logger.warn(
        `In-flight settlement run did not finish within ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms; proceeding with shutdown. The run may be interrupted.`,
      );
    }
  }

  private waitForInFlight(): Promise<boolean> {
    const run = this.inFlight;
    if (!run) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), SHUTDOWN_DRAIN_TIMEOUT_MS);

      run
        .catch(() => undefined)
        .then(() => {
          clearTimeout(timer);
          resolve(true);
        });
    });
  }
}
