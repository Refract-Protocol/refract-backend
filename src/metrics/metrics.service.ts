import { Injectable } from "@nestjs/common";
import { Counter, Gauge, Histogram, Registry } from "@prometheus-io/client";
import { NextFunction, Request, RequestHandler, Response } from "express";

type Outcome = "success" | "failure";
type OracleOutcome = Outcome | "mocked";

/** Encoded as the numeric value of `oracle_breaker_state`. */
export enum OracleBreakerState {
  Closed = 0,
  HalfOpen = 1,
  Open = 2,
}

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
  private readonly oracleSourceRequestDuration = new Histogram<"source" | "outcome">({
    name: "oracle_source_request_duration_seconds",
    help: "Oracle upstream source request duration in seconds, labeled by source and outcome.",
    labelNames: ["source", "outcome"],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [this.registry],
  });
  private readonly oracleSourceFailures = new Counter<"source">({
    name: "oracle_source_failures_total",
    help: "Failed oracle upstream source requests, labeled by source.",
    labelNames: ["source"],
    registers: [this.registry],
  });
  private readonly oracleReadingAge = new Gauge<"coverage_type">({
    name: "oracle_reading_age_seconds",
    help: "Age in seconds of the most recent oracle reading, labeled by coverage type.",
    labelNames: ["coverage_type"],
    registers: [this.registry],
  });
  private readonly oracleSourceDispersion = new Gauge<"coverage_type">({
    name: "oracle_source_dispersion",
    help: "Relative spread across oracle sources for the latest reading, labeled by coverage type.",
    labelNames: ["coverage_type"],
    registers: [this.registry],
  });
  private readonly oracleQuorumFailures = new Counter<"coverage_type">({
    name: "oracle_quorum_failures_total",
    help: "Oracle readings withheld because too few sources agreed, labeled by coverage type.",
    labelNames: ["coverage_type"],
    registers: [this.registry],
  });
  private readonly oracleBreakerState = new Gauge<"coverage_type">({
    name: "oracle_breaker_state",
    help: "Oracle circuit breaker state per coverage type: 0=closed, 1=half-open, 2=open.",
    labelNames: ["coverage_type"],
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

  recordOracleSourceRequest(source: string, outcome: Outcome, durationSeconds: number): void {
    this.oracleSourceRequestDuration.labels({ source, outcome }).observe(durationSeconds);
    if (outcome === "failure") this.oracleSourceFailures.labels({ source }).inc();
  }

  setOracleReadingAge(coverageType: string, ageSeconds: number): void {
    this.oracleReadingAge.labels({ coverage_type: coverageType }).set(ageSeconds);
  }

  setOracleSourceDispersion(coverageType: string, dispersion: number): void {
    this.oracleSourceDispersion.labels({ coverage_type: coverageType }).set(dispersion);
  }

  recordOracleQuorumFailure(coverageType: string): void {
    this.oracleQuorumFailures.labels({ coverage_type: coverageType }).inc();
  }

  setOracleBreakerState(coverageType: string, state: OracleBreakerState): void {
    this.oracleBreakerState.labels({ coverage_type: coverageType }).set(state);
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
