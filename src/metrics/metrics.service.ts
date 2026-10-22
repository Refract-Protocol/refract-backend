import { Injectable } from "@nestjs/common";
import { Counter, Gauge, Histogram, Registry } from "@prometheus-io/client";
import { NextFunction, Request, RequestHandler, Response } from "express";

type Outcome = "success" | "failure";
type OracleOutcome = Outcome | "mocked";

@Injectable()
export class MetricsService {
  private readonly registry = new Registry();
  private readonly httpRequests = new Counter<"method" | "route" | "status_code">({
    name: "refract_http_requests_total",
    help: "Total HTTP requests completed by the backend.",
    labelNames: ["method", "route", "status_code"],
    registers: [this.registry],
  });
  private readonly httpRequestDuration = new Histogram<"method" | "route" | "status_code">({
    name: "refract_http_request_duration_seconds",
    help: "HTTP request duration in seconds.",
    labelNames: ["method", "route", "status_code"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  private readonly schedulerRuns = new Counter<"scheduler" | "outcome">({
    name: "refract_scheduler_runs_total",
    help: "Completed scheduler runs, labeled by scheduler and outcome.",
    labelNames: ["scheduler", "outcome"],
    registers: [this.registry],
  });
  private readonly schedulerDuration = new Histogram<"scheduler">({
    name: "refract_scheduler_run_duration_seconds",
    help: "Scheduler run duration in seconds.",
    labelNames: ["scheduler"],
    buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
    registers: [this.registry],
  });
  private readonly sorobanRpcDuration = new Histogram<"operation" | "outcome">({
    name: "refract_soroban_rpc_duration_seconds",
    help: "Soroban RPC call duration in seconds, labeled by method and outcome.",
    labelNames: ["operation", "outcome"],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [this.registry],
  });
  private readonly oracleChecks = new Counter<"coverage_type" | "outcome">({
    name: "refract_oracle_checks_total",
    help: "Oracle checks completed, labeled by coverage type and outcome.",
    labelNames: ["coverage_type", "outcome"],
    registers: [this.registry],
  });
  private readonly oracleCheckDuration = new Histogram<"coverage_type">({
    name: "refract_oracle_check_duration_seconds",
    help: "Oracle check duration in seconds.",
    labelNames: ["coverage_type"],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [this.registry],
  });
  private readonly drDrillLastRunTimestamp = new Gauge<"drill">({
    name: "refract_dr_drill_last_run_timestamp_seconds",
    help: "Unix timestamp of the last completed disaster-recovery restore drill.",
    labelNames: ["drill"],
    registers: [this.registry],
  });
  private readonly drDrillPassed = new Gauge<"drill">({
    name: "refract_dr_drill_passed",
    help: "Whether the last disaster-recovery restore drill passed (1) or failed (0).",
    labelNames: ["drill"],
    registers: [this.registry],
  });
  private readonly drDrillRestoreDuration = new Gauge<"drill">({
    name: "refract_dr_drill_restore_duration_seconds",
    help: "Measured restore duration (RTO) of the last disaster-recovery drill in seconds.",
    labelNames: ["drill"],
    registers: [this.registry],
  });
  private readonly drDrillDataLossWindow = new Gauge<"drill">({
    name: "refract_dr_drill_data_loss_window_seconds",
    help: "Measured data-loss window (RPO) of the last disaster-recovery drill in seconds.",
    labelNames: ["drill"],
    registers: [this.registry],
  });
  private readonly incidentsOpened = new Counter<"trigger_class">({
    name: "refract_incidents_opened_total",
    help: "Incidents opened, labeled by trigger class.",
    labelNames: ["trigger_class"],
    registers: [this.registry],
  });

  readonly httpMiddleware: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === "/metrics") {
      next();
      return;
    }

    const startedAt = process.hrtime.bigint();
    res.once("finish", () => {
      const route = typeof req.route?.path === "string" ? req.route.path : "unmatched";
      const labels = {
        method: req.method,
        route,
        status_code: String(res.statusCode),
      };
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      this.httpRequests.labels(labels).inc();
      this.httpRequestDuration.labels(labels).observe(durationSeconds);
    });
    next();
  };

  recordSchedulerRun(scheduler: string, outcome: Outcome, durationSeconds: number): void {
    this.schedulerRuns.labels({ scheduler, outcome }).inc();
    this.schedulerDuration.labels({ scheduler }).observe(durationSeconds);
  }

  recordOracleCheck(coverageType: string, outcome: OracleOutcome, durationSeconds: number): void {
    this.oracleChecks.labels({ coverage_type: coverageType, outcome }).inc();
    this.oracleCheckDuration.labels({ coverage_type: coverageType }).observe(durationSeconds);
  }

  recordDrDrillResult(result: {
    drill?: string;
    passed: boolean;
    restoreDurationSeconds: number;
    dataLossWindowSeconds: number;
    completedAt?: Date;
  }): void {
    const drill = result.drill ?? "restore";
    const completedAt = result.completedAt ?? new Date();
    this.drDrillLastRunTimestamp.labels({ drill }).set(completedAt.getTime() / 1000);
    this.drDrillPassed.labels({ drill }).set(result.passed ? 1 : 0);
    this.drDrillRestoreDuration.labels({ drill }).set(result.restoreDurationSeconds);
    this.drDrillDataLossWindow.labels({ drill }).set(result.dataLossWindowSeconds);
  }

  recordIncidentOpened(triggerClass: string): void {
    this.incidentsOpened.labels({ trigger_class: triggerClass }).inc();
  }

  async observeSorobanRpc<T>(operation: string, call: () => Promise<T>): Promise<T> {
    const startedAt = process.hrtime.bigint();
    let outcome: Outcome = "success";
    try {
      return await call();
    } catch (error) {
      outcome = "failure";
      throw error;
    } finally {
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      this.sorobanRpcDuration.labels({ operation, outcome }).observe(durationSeconds);
    }
  }

  metrics(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
