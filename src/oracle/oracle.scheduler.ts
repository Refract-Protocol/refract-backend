import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { OracleService } from './oracle.service';
import { ProtocolParametersService } from '../parameters/protocol-parameters.service';
import { ProtocolParameterKey } from '../parameters/protocol-parameter-key.enum';

const ORACLE_REFRESH_JOB_NAME = 'oracle-refresh';

@Injectable()
export class OracleScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OracleScheduler.name);

  constructor(
    private readonly oracleService: OracleService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly protocolParameters: ProtocolParametersService,
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

  onModuleDestroy(): void {
    if (this.schedulerRegistry.doesExist('cron', ORACLE_REFRESH_JOB_NAME)) {
      this.schedulerRegistry.deleteCronJob(ORACLE_REFRESH_JOB_NAME);
    }
  }

  private async refresh(): Promise<void> {
    try {
      await this.oracleService.refreshPrices();
    } catch (error) {
      this.logger.error('Oracle refresh failed', error as Error);
    }
  }
}
