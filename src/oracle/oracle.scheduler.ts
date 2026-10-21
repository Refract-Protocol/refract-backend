import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { OracleService } from './oracle.service';
import { ProtocolParametersService } from '../parameters/protocol-parameters.service';
import { ProtocolParameterKey } from '../parameters/protocol-parameter-key.enum';
import { OraclePipelineLifecycle } from './shutdown/oracle-pipeline-lifecycle.service';

const ORACLE_REFRESH_JOB_NAME = 'oracle-refresh';

@Injectable()
export class OracleScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OracleScheduler.name);

  constructor(
    private readonly oracleService: OracleService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly protocolParameters: ProtocolParametersService,
    private readonly lifecycle: OraclePipelineLifecycle,
  ) {}

  async onModuleInit(): Promise<void> {
    const intervalSeconds = await this.protocolParameters.getNumber(
      ProtocolParameterKey.ORACLE_SCHEDULER_INTERVAL_SECONDS,
    );

    const job = new CronJob(`*/${intervalSeconds} * * * * *`, () => {
      void this.refresh();
    });

    this.schedulerRegistry.addCronJob(ORACLE_REFRESH_JOB_NAME, job);
    job.start();

    this.logger.log(
      `Oracle refresh scheduler started with ${intervalSeconds}s interval`,
    );
  }

  /**
   * Shutdown step 1: stop the cron job so no new poll starts. A poll that
   * is already running finishes inside OraclePipelineLifecycle's drain.
   */
  onModuleDestroy(): void {
    if (this.schedulerRegistry.doesExist('cron', ORACLE_REFRESH_JOB_NAME)) {
      this.schedulerRegistry.deleteCronJob(ORACLE_REFRESH_JOB_NAME);
    }
  }

  private async refresh(): Promise<void> {
    try {
      // Skips the poll when shutting down or when another replica leads.
      await this.lifecycle.runPoll(() => this.oracleService.refreshPrices());
    } catch (error) {
      this.logger.error('Oracle refresh failed', error as Error);
    }
  }
}
