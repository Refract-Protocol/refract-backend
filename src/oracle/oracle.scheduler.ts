import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { OracleEventRepository } from "./oracle-event.repository";
import { OracleGateway } from "./oracle.gateway";
import { OracleService } from "./oracle.service";

/**
 * Polls oracle data sources on a fixed interval, persists every reading to
 * `oracle_events` (via OracleEventRepository), and broadcasts anything
 * above "low" severity over the WebSocket feed — same 60s cadence as the
 * setInterval loop in the old src/index.ts, now expressed with Nest's
 * @Interval scheduler.
 */
@Injectable()
export class OracleScheduler {
  private readonly logger = new Logger(OracleScheduler.name);

  constructor(
    private readonly oracleService: OracleService,
    private readonly oracleGateway: OracleGateway,
    private readonly oracleEventRepository: OracleEventRepository
  ) {}

  @Interval(60_000)
  async pollOracles(): Promise<void> {
    try {
      const readings = await this.oracleService.checkAll();

      // Persist all readings in a single batch — fire-and-forget, never
      // blocks the broadcast loop below.
      void this.oracleEventRepository.recordBatch(readings);

      for (const reading of readings) {
        if (reading.severity !== "low") {
          this.oracleGateway.broadcastAlert(reading);
          this.logger.warn(`Oracle alert: ${reading.coverageType} — ${reading.message}`);
        }
      }
    } catch (err) {
      this.logger.error("Oracle monitor error", err instanceof Error ? err.stack : err);
    }
  }
}
