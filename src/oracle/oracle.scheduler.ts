import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { OracleGateway } from "./oracle.gateway";
import { OraclePublisherService } from "./oracle-publisher.service";
import { OracleReading } from "./oracle-reading";
import { OracleService } from "./oracle.service";
import {
  BASE_ORACLE_INTERVAL_MS,
  calculateOracleIntervalMs,
  MAX_ORACLE_INTERVAL_MS,
} from "./oracle-cadence";

const FEEDS = [
  "StablecoinDepeg",
  "MarketCrash",
  "LiquidationShield",
  "SmartContractRisk",
  "FlightDelay",
] as const;

type OracleFeed = (typeof FEEDS)[number];

@Injectable()
export class OracleScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OracleScheduler.name);
  private readonly timers = new Map<OracleFeed, NodeJS.Timeout>();
  private readonly lastReadings = new Map<OracleFeed, OracleReading>();
  private readonly lastValues = new Map<OracleFeed, number>();
  private stopping = false;

  constructor(
    private readonly oracleService: OracleService,
    private readonly oracleGateway: OracleGateway,
    private readonly oraclePublisher: OraclePublisherService,
  ) {}

  onModuleInit(): void {
    this.logger.log("Oracle adaptive polling scheduler started");
    for (const feed of FEEDS) {
      this.schedule(feed, 0);
    }
  }

  onModuleDestroy(): void {
    this.stopping = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private schedule(feed: OracleFeed, delayMs: number): void {
    if (this.stopping) return;
    const previous = this.timers.get(feed);
    if (previous) clearTimeout(previous);

    const timer = setTimeout(() => {
      this.timers.delete(feed);
      void this.poll(feed);
    }, delayMs);
    timer.unref?.();
    this.timers.set(feed, timer);
  }

  private async poll(feed: OracleFeed): Promise<void> {
    if (this.stopping) return;
    try {
      const reading = await this.readFeed(feed);
      this.lastReadings.set(feed, reading);
      if (!reading.degraded) {
        this.lastValues.set(feed, reading.value);
      }
      if (reading.severity !== "low") {
        this.oracleGateway.broadcastAlert(reading);
        this.logger.warn(`Oracle alert: ${reading.coverageType} — ${reading.message}`);
      }
      await this.oraclePublisher.maybePublish(reading);
    } catch (error) {
      this.logger.error(
        `Oracle refresh failed for ${feed}`,
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      if (!this.stopping) {
        this.schedule(feed, this.nextInterval(feed));
      }
    }
  }

  private async readFeed(feed: OracleFeed): Promise<OracleReading> {
    switch (feed) {
      case "StablecoinDepeg":
        return this.oracleService.checkStablecoinDepeg();
      case "MarketCrash":
        return this.oracleService.checkMarketCrash();
      case "LiquidationShield":
        return this.oracleService.checkLiquidationShield();
      case "SmartContractRisk":
        return this.oracleService.checkSmartContractRisk();
      case "FlightDelay":
        return this.oracleService.checkFlightDelay("UNKNOWN");
    }
  }

  private nextInterval(feed: OracleFeed): number {
    const quotaPressure = this.oracleService.getQuotaPressure(feed);
    const previous = this.lastReadings.get(feed);
    if (previous) {
      return calculateOracleIntervalMs(previous, this.lastValues.get(feed), quotaPressure);
    }
    return Math.min(
      MAX_ORACLE_INTERVAL_MS,
      Math.max(BASE_ORACLE_INTERVAL_MS, Math.round(BASE_ORACLE_INTERVAL_MS * (1 + 2 * quotaPressure))),
    );
  }
}
