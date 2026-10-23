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
  private readonly providerProbes = new Counter<"source" | "outcome">({
    name: "refract_provider_probes_total",
    help: "Synthetic canary probes completed per data provider, labeled by outcome.",
    labelNames: ["source", "outcome"],
    registers: [this.registry],
  });
  private readonly providerProbeDuration = new Histogram<"source">({
    name: "refract_provider_probe_duration_seconds",
    help: "Synthetic canary probe duration in seconds per data provider.",
    labelNames: ["source"],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [this.registry],
  });
  private readonly providerFrozenPayloads = new Counter<"source">({
    name: "refract_provider_frozen_payload_detections_total",
    help: "Canary probes that received an identical payload repeatedly, per data provider.",
    labelNames: ["source"],
    registers: [this.registry],
  });
  private readonly providerSchemaDrift = new Counter<"source" | "kind">({
    name: "refract_provider_schema_drift_detections_total",
    help: "Canary probes that detected schema, parse, or scale drift, per data provider and drift kind.",
    labelNames: ["source", "kind"],
    registers: [this.registry],
  });

  private readonly oraclePublishQueueDepth = new Gauge<"priority">({
    name: "refract_oracle_publish_queue_depth",
    help: "Oracle decisions waiting to be published on-chain, by priority.",
    labelNames: ["priority"],
    registers: [this.registry],
  });
  private readonly oraclePublishBackpressure = new Gauge({
    name: "refract_oracle_publish_backpressure",
    help: "1 when oracle publishing backpressure is active (low-priority polling reduced).",
    registers: [this.registry],
  });
  private readonly oraclePublishRpcLatency = new Gauge({
    name: "refract_oracle_publish_rpc_latency_seconds",
    help: "Smoothed Soroban RPC submission latency observed by the oracle publisher.",
    registers: [this.registry],
  });
  private readonly oraclePublishDecisions = new Counter<"outcome">({
    name: "refract_oracle_publish_decisions_total",
    help: "Oracle decisions by publish outcome (published, retried, split, failed).",
    labelNames: ["outcome"],
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

  recordOraclePublishState(state: {
    depthHigh: number;
    depthLow: number;
    backpressure: boolean;
    rpcLatencySeconds: number;
  }): void {
    this.oraclePublishQueueDepth.labels({ priority: "high" }).set(state.depthHigh);
    this.oraclePublishQueueDepth.labels({ priority: "low" }).set(state.depthLow);
    this.oraclePublishBackpressure.set(state.backpressure ? 1 : 0);
    this.oraclePublishRpcLatency.set(state.rpcLatencySeconds);
  }

  recordOraclePublishDecisions(outcome: "published" | "retried" | "split" | "failed", count: number): void {
    this.oraclePublishDecisions.labels({ outcome }).inc(count);
  }

  recordProviderProbe(source: string, outcome: Outcome, durationSeconds: number): void {
    this.providerProbes.labels({ source, outcome }).inc();
    this.providerProbeDuration.labels({ source }).observe(durationSeconds);
  }

  recordProviderFrozenPayload(source: string): void {
    this.providerFrozenPayloads.labels({ source }).inc();
  }

  recordProviderSchemaDrift(source: string, kind: string): void {
    this.providerSchemaDrift.labels({ source, kind }).inc();
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
