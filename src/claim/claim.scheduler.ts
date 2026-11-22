import { Injectable, Logger, OnApplicationShutdown, OnModuleInit, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ClaimService, ScanOutcome } from './claim.service';
import { ProtocolParametersService } from '../parameters/protocol-parameters.service';
import { runsPipeline } from '../runtime/process-role';
import { PipelineHeartbeat } from '../runtime/pipeline-heartbeat';
import { LeaderElector } from '../leader/leader-elector.service';
import { isSandboxMode } from '../config/configuration';

export const CLAIM_PIPELINE_STAGE = 'claim-settlement';

/**
 * Settings that must be present before the settlement loop can sign and submit
 * Soroban transactions. A relayer key is either the raw secret or the AWS
 * Secrets Manager id it is loaded from.
 */
export const RELAYER_KEY_SETTINGS = ['ORACLE_RELAYER_SECRET', 'ORACLE_RELAYER_SECRET_ID'] as const;

/**
 * Returns the name of the missing relayer setting, or null when one is
 * configured. Kept pure so the startup check is trivially testable.
 */
export function missingRelayerSetting(env: NodeJS.ProcessEnv = process.env): string | null {
  const hasSecret = Boolean((env.ORACLE_RELAYER_SECRET ?? '').trim());
  const hasSecretId = Boolean((env.ORACLE_RELAYER_SECRET_ID ?? '').trim());
  if (hasSecret || hasSecretId) {
    return null;
  }
  return RELAYER_KEY_SETTINGS.join(' / ');
}

/**
 * Upper bound (ms) we are willing to wait for an in-flight settlement run to
 * finish before letting the process shut down. Kept in sync with the
 * bootstrap-level shutdown grace period so a stuck settlement cannot block
 * SIGTERM handling indefinitely.
 */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000;

@Injectable()
export class ClaimScheduler implements OnModuleInit, OnApplicationShutdown {
  readonly logger = new Logger(ClaimScheduler.name);

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

  /**
   * Set when the relayer key is missing at startup so the settlement loop is
   * disabled instead of failing opaquely on every cycle.
   */
  private disabledReason: string | null = null;

  constructor(
    private readonly claimService: ClaimService,
    private readonly protocolParameters: ProtocolParametersService,
    @Optional() private readonly heartbeat?: PipelineHeartbeat,
    private readonly leaderElector: LeaderElector,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!runsPipeline()) {
      this.logger.log('Claim settlement disabled in this process (PROCESS_ROLE=api)');
      return;
    }
    this.heartbeat?.expect(CLAIM_PIPELINE_STAGE);

    const missing = missingRelayerSetting();
    if (missing) {
      this.disabledReason = missing;
      const sandbox = isSandboxMode();
      this.logger.warn(
        `Claim scheduler disabled: missing relayer key setting ${missing}. ` +
          `Settlements will not run until ${missing} is configured` +
          (sandbox ? ' (sandbox mode: no on-chain settlement expected).' : '.'),
      );
      return;
    }

    const interval = await this.getIntervalSeconds();
    this.logger.log(`Claim scheduler initialized with interval ${interval}s`);
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.shuttingDown = true;

    if (!this.inFlight) {
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

  /**
   * Resolve the claim scheduler interval from the protocol-parameters registry,
   * falling back to the default when no override is configured.
   */
  private async getIntervalSeconds(): Promise<number> {
    const value = await this.protocolParameters.getNumber(
      CLAIM_SCHEDULER_INTERVAL_KEY,
      DEFAULT_CLAIM_SCHEDULER_INTERVAL_SECONDS,
    );
    return value > 0 ? value : DEFAULT_CLAIM_SCHEDULER_INTERVAL_SECONDS;
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async handleClaimSettlement(): Promise<void> {
    // Settlement triggers payouts, so it only runs in the worker tier.
    if (!runsPipeline()) {
      return;
    }

    if (this.disabledReason) {
      this.logger.debug(
        `Skipping claim settlement run: scheduler disabled (missing ${this.disabledReason}).`,
      );
      return;
    }

    if (this.shuttingDown) {
      this.logger.log(
        'Skipping claim settlement run: scheduler is shutting down.',
      );
      return;
    }

    if (!this.leaderElector.isLeader()) {
      this.logger.debug('Skipping claim settlement run: this instance is not the leader.');
      return;
    }

    if (this.inFlight) {
      this.logger.warn(
        'Skipping claim settlement run: a previous run is still in flight.',
      );
      return;
    }

    this.logger.debug("Running claim processing");

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
    await this.scanAndSettle();
  }

  async scanAndSettle(): Promise<void> {
    try {
      const outcome: ScanOutcome = await this.claimService.processTriggeredWithStats();
      const { counts } = outcome;
      this.logger.log(
        `claim scan: scanned=${counts.scanned} triggered=${counts.triggered} settled=${counts.settled} deferred=${counts.deferred} transient=${counts.failedTransient} permanent=${counts.failedPermanent} indeterminate=${counts.failedIndeterminate} deadLettered=${counts.deadLettered}`
      );
      if (outcome.settled.length > 0) {
        this.logger.log(`Settled ${outcome.settled.length} claims this cycle`);
      }
      this.heartbeat?.beat(CLAIM_PIPELINE_STAGE);
    } catch (error) {
      this.logger.error("Claim scan failed", error instanceof Error ? error.stack : String(error));
    }
  }

  private waitForInFlight(): Promise<boolean> {
    const run = this.inFlight;
    if (!run) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), SHUTDOWN_DRAIN_TIMEOUT_MS);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      run
        .catch(() => undefined)
        .then(() => {
          clearTimeout(timer);
          resolve(true);
        });
    });
  }
}
