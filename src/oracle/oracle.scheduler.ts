import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Optional } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { CronJob } from "cron";
import { MetricsService, OracleTickOutcome } from "../metrics/metrics.service";
import { HealthService } from "../health/health.service";
import { OracleGateway } from "./oracle.gateway";
import { OraclePublisherService } from "./oracle-publisher.service";
import { OracleReading } from "./oracle-reading";
import { OracleService } from "./oracle.service";
import { ProtocolParametersService } from "../parameters/protocol-parameters.service";
import { ProtocolParameterKey } from "../parameters/protocol-parameter-key.enum";
import { ReadingBus } from "./reading-bus";
import { runsPipeline } from "../runtime/process-role";
import { PipelineHeartbeat } from "../runtime/pipeline-heartbeat";

const ORACLE_REFRESH_JOB_NAME = "oracle-refresh";
export const ORACLE_PIPELINE_STAGE = "oracle";

const DEFAULT_POLL_INTERVAL_MS = 60_000;

function pollIntervalMs(): number {
  const value = Number(process.env.ORACLE_SCHEDULER_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS);
  if (!Number.isInteger(value) || value < 1_000 || value > 3_600_000) {
    throw new Error("ORACLE_SCHEDULER_INTERVAL_MS must be an integer between 1000 and 3600000");
  }
  return value;
}

@Injectable()
export class OracleScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OracleScheduler.name);
  private polling = false;

  constructor(
    private readonly oracleService: OracleService,
    private readonly oracleGateway: OracleGateway,
    private readonly oraclePublisher: OraclePublisherService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly protocolParameters: ProtocolParametersService,
    private readonly readingBus: ReadingBus,
    @Optional() private readonly metricsService?: MetricsService,
    @Optional() private readonly healthService?: HealthService,
    @Optional() private readonly heartbeat?: PipelineHeartbeat,
  ) {}

  async onModuleInit(): Promise<void> {
    // Polling and consensus belong to the worker tier. The API only relays
    // what the worker publishes (see OracleFeedRelay).
    if (!runsPipeline()) {
      this.logger.log("Oracle polling disabled in this process (PROCESS_ROLE=api)");
      return;
    }
    this.heartbeat?.expect(ORACLE_PIPELINE_STAGE);

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
    if (this.schedulerRegistry.doesExist("cron", ORACLE_REFRESH_JOB_NAME)) {
      this.schedulerRegistry.deleteCronJob(ORACLE_REFRESH_JOB_NAME);
    }
  }

  private async refresh(): Promise<void> {
    if (this.polling) {
      this.logger.warn("Skipping oracle poll because the previous round is still running");
      return;
    }
    this.polling = true;
    const startedAt = Date.now();
    let outcome: "success" | "failure" = "success";
    let tickOutcome: OracleTickOutcome = "success";

    try {
      let result: unknown;
      try {
        result = await this.oracleService.refreshPrices();
      } catch (error) {
        tickOutcome = "provider_error";
        throw error;
      }
      const readings = Array.isArray(result) ? (result as OracleReading[]) : [];
      const live = readings.filter((reading) => !reading.degraded);
      if (readings.length > 0 && live.length === 0) {
        tickOutcome = "provider_error";
      } else if (live.length > 0 && live.every((reading) => !reading.provenance)) {
        tickOutcome = "no_consensus";
      }

      const infrastructure = await this.healthService?.getInfrastructureReadiness();
      if (infrastructure && !infrastructure.ready) {
        this.logger.warn("Skipping oracle publications while required infrastructure is not ready");
        return;
      }

      for (const reading of readings) {
        await this.processReading(reading);
      }

      // Hand readings to the API tier for the WebSocket feed and reads.
      await this.readingBus.publishAll(readings);
      this.heartbeat?.beat(ORACLE_PIPELINE_STAGE);
    } catch (error) {
      outcome = "failure";
      this.logger.error("Oracle refresh failed", error instanceof Error ? error.stack : String(error));
    } finally {
      this.polling = false;
      this.metricsService?.recordSchedulerRun(
        "oracle",
        outcome,
        (Date.now() - startedAt) / 1000,
      );
      this.metricsService?.recordOracleTick(tickOutcome);
    }
  }

  private async processReading(reading: OracleReading): Promise<void> {
    const feed = reading.feedId ?? reading.coverageType;
    const observedAt = reading.observedAt ?? Date.now();
    const deadlineAt = reading.deadlineAt ?? observedAt + 30_000;
    if (reading.degraded) {
      this.logger.warn(`Skipping degraded ${feed} reading`);
      return;
    }
    if (reading.fetchDurationMs !== undefined) {
      this.metricsService?.recordOracleStage(feed, "source", reading.fetchDurationMs / 1000);
    }

    const consensusDuration = (Date.now() - observedAt) / 1000;
    this.metricsService?.recordOracleStage(feed, "consensus", consensusDuration);
    if (Date.now() >= deadlineAt) {
      this.metricsService?.recordOracleDeadlineBreach(
        feed,
        "consensus",
        (Date.now() - deadlineAt) / 1000,
      );
      this.logger.warn(`Aborting stale ${feed} reading before publication`);
      return;
    }

    await this.oraclePublisher.maybePublish(reading, deadlineAt);
    if (Date.now() >= deadlineAt) {
      return;
    }

    if (reading.severity !== "low") {
      this.oracleGateway.broadcastAlert(reading);
    }
  }
}
