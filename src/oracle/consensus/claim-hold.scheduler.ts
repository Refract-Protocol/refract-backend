import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ClaimHoldService } from "./claim-hold.service";
import { CONSENSUS_CONFIG, ConsensusConfig } from "./consensus.config";

/**
 * Re-evaluates held claims every CLAIM_HOLD_REEVALUATE_INTERVAL_MS.
 * Runs are serialised: a slow run is never overlapped by the next tick.
 */
@Injectable()
export class ClaimHoldScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClaimHoldScheduler.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly holds: ClaimHoldService,
    @Inject(CONSENSUS_CONFIG) private readonly config: ConsensusConfig,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => this.tick(), this.config.holdReevaluateIntervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  tick(): void {
    if (this.running) return;
    this.running = true;
    try {
      const summary = this.holds.reevaluateAll();
      if (summary.released || summary.escalated) {
        this.logger.log(`Held claims re-evaluated: ${JSON.stringify(summary)}`);
      }
    } catch (err) {
      this.logger.error(`Hold re-evaluation failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.running = false;
    }
  }
}
