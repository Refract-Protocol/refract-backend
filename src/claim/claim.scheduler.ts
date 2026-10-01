import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ClaimService } from './claim.service';
import { ProtocolParametersService } from '../parameters/protocol-parameters.service';

/**
 * Default interval (in seconds) used when the registry has no override for the
 * claim scheduler interval. Kept as a fallback only; the effective value is
 * read from the protocol-parameters registry at runtime so governance can
 * adjust it without a code deploy.
 */
export const DEFAULT_CLAIM_SCHEDULER_INTERVAL_SECONDS = 60;

/** Registry key for the claim scheduler interval. */
export const CLAIM_SCHEDULER_INTERVAL_KEY = 'scheduler.claim.interval_seconds';

@Injectable()
export class ClaimScheduler implements OnModuleInit {
  private readonly logger = new Logger(ClaimScheduler.name);

  constructor(
    private readonly claimService: ClaimService,
    private readonly protocolParameters: ProtocolParametersService,
  ) {}

  async onModuleInit(): Promise<void> {
    const interval = await this.getIntervalSeconds();
    this.logger.log(`Claim scheduler initialized with interval ${interval}s`);
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
  async handleClaimProcessing(): Promise<void> {
    const interval = await this.getIntervalSeconds();
    this.logger.debug(`Running claim processing (interval=${interval}s)`);
    await this.claimService.processPendingClaims();
  }
}
