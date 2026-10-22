import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { OracleService } from './oracle.service';
import { ProtocolParametersService } from '../parameters/protocol-parameters.service';
import { ProtocolParameterKey } from '../parameters/protocol-parameter-key.enum';
import { AlertingService } from '../alerts/alerting.service';
import { AlertSeverity } from '../alerts/alert-severity.enum';
import { PartitionMaintenanceService } from '../db/partition-maintenance.service';
import { IncidentTimelineService } from '../services/incident-timeline.service';
import { DisasterRecoveryService } from '../services/disaster-recovery.service';

const ORACLE_REFRESH_JOB_NAME = 'oracle-refresh';
const PARTITION_MAINTENANCE_JOB_NAME = 'oracle-partition-maintenance';
const INCIDENT_TIMELINE_JOB_NAME = 'oracle-incident-timeline';
const DR_DRILL_JOB_NAME = 'oracle-dr-drill';

/** Number of future monthly partitions to keep pre-created. */
const FUTURE_PARTITIONS_TO_PRECREATE = 3;

@Injectable()
export class OracleScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OracleScheduler.name);

  constructor(
    private readonly oracleService: OracleService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly protocolParameters: ProtocolParametersService,
    private readonly alerting: AlertingService,
    private readonly partitionMaintenance: PartitionMaintenanceService,
    private readonly incidentTimeline: IncidentTimelineService,
    private readonly disasterRecovery: DisasterRecoveryService,
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

    // Run partition maintenance immediately on boot, then daily at 02:00.
    void this.runPartitionMaintenance();
    const partitionJob = new CronJob('0 2 * * *', () => {
      void this.runPartitionMaintenance();
    });
    this.schedulerRegistry.addCronJob(PARTITION_MAINTENANCE_JOB_NAME, partitionJob);
    partitionJob.start();

    // Weekly incident-timeline generation (Mondays at 03:00).
    const incidentJob = new CronJob('0 3 * * 1', () => {
      void this.runIncidentTimelineGeneration();
    });
    this.schedulerRegistry.addCronJob(INCIDENT_TIMELINE_JOB_NAME, incidentJob);
    incidentJob.start();

    // Weekly DR drill trigger hook (Sundays at 04:00).
    const drDrillJob = new CronJob('0 4 * * 0', () => {
      void this.runDrDrill();
    });
    this.schedulerRegistry.addCronJob(DR_DRILL_JOB_NAME, drDrillJob);
    drDrillJob.start();
  }

  onModuleDestroy(): void {
    for (const name of [
      ORACLE_REFRESH_JOB_NAME,
      PARTITION_MAINTENANCE_JOB_NAME,
      INCIDENT_TIMELINE_JOB_NAME,
      DR_DRILL_JOB_NAME,
    ]) {
      if (this.schedulerRegistry.doesExist('cron', name)) {
        this.schedulerRegistry.deleteCronJob(name);
      }
    }
  }

  private async refresh(): Promise<void> {
    try {
      await this.oracleService.refreshPrices();
    } catch (error) {
      this.logger.error('Oracle refresh failed', error as Error);
    }
  }

  private async runPartitionMaintenance(): Promise<void> {
    try {
      const result = await this.partitionMaintenance.ensureFuturePartitions(
        FUTURE_PARTITIONS_TO_PRECREATE,
      );

      if (result.nextPartitionMissing) {
        await this.alerting.raise({
          severity: AlertSeverity.CRITICAL,
          title: 'Oracle partition maintenance: next partition missing',
          description:
            'The next monthly partition for oracle_readings/oracle_evidence is missing. ' +
            'Writes may fail once the current partition is exhausted.',
        });
      }

      this.logger.log(
        `Partition maintenance complete: created=${result.created.join(',') || 'none'} ` +
          `nextPartitionMissing=${result.nextPartitionMissing}`,
      );
    } catch (error) {
      this.logger.error('Partition maintenance failed', error as Error);
      await this.alerting.raise({
        severity: AlertSeverity.CRITICAL,
        title: 'Oracle partition maintenance failed',
        description: `Partition pre-creation failed: ${(error as Error).message}`,
      });
    }
  }

  private async runIncidentTimelineGeneration(): Promise<void> {
    try {
      await this.incidentTimeline.generateWeeklyTimelines();
    } catch (error) {
      this.logger.error('Incident timeline generation failed', error as Error);
    }
  }

  private async runDrDrill(): Promise<void> {
    try {
      await this.disasterRecovery.triggerScheduledDrill();
    } catch (error) {
      this.logger.error('DR drill trigger failed', error as Error);
    }
  }
}
