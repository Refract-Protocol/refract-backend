import { Injectable } from "@nestjs/common";
import { Counter, Gauge, Histogram, Registry } from "@prometheus-io/client";
import { NextFunction, Request, RequestHandler, Response } from "express";
import type { RelayerMetricsSink } from "../stellar/relayer-monitor/relayer-balance-monitor.service";
import { BalanceAssessment, FeeSpendSummary, tierRank } from "../stellar/relayer-monitor/relayer-balance.policy";

type Outcome = "success" | "failure";
type OracleOutcome = Outcome | "mocked";

@Injectable()
export class MetricsService implements RelayerMetricsSink {
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
  private readonly oracleStageDuration = new Histogram<"feed" | "stage">({
    name: "refract_oracle_stage_duration_seconds",
    help: "Oracle feed processing duration by feed and pipeline stage.",
    labelNames: ["feed", "stage"],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [this.registry],
  });
  private readonly oracleDeadlineBreaches = new Counter<"feed" | "stage">({
    name: "refract_oracle_deadline_breaches_total",
    help: "Oracle feed publication deadlines breached, labeled by feed and stage.",
    labelNames: ["feed", "stage"],
    registers: [this.registry],
  });
  private readonly oracleDeadlineOverrun = new Histogram<"feed" | "stage">({
    name: "refract_oracle_deadline_overrun_seconds",
    help: "Time by which oracle feed processing exceeded its publication deadline.",
    labelNames: ["feed", "stage"],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [this.registry],
  });

  private readonly openDisputes = new Gauge({
    name: "refract_claim_disputes_open",
    help: "Claim disputes currently open or under review.",
    registers: [this.registry],
  });

  private readonly relayerBalance = new Gauge({
    name: "refract_relayer_balance_stroops",
    help: "Relayer native balance in stroops.",
    registers: [this.registry],
  });
  private readonly relayerSpendable = new Gauge({
    name: "refract_relayer_spendable_stroops",
    help: "Relayer balance available for fees after reserve and liabilities, in stroops.",
    registers: [this.registry],
  });
  private readonly relayerRunwayHours = new Gauge({
    name: "refract_relayer_runway_hours",
    help: "Hours of fees the relayer can still pay at the current spend rate (-1 when unknown).",
    registers: [this.registry],
  });
  private readonly relayerRunwaySubmissions = new Gauge({
    name: "refract_relayer_runway_submissions",
    help: "Submissions the relayer can still pay for at the average fee (-1 when unknown).",
    registers: [this.registry],
  });
  private readonly relayerFeeRate = new Gauge({
    name: "refract_relayer_fee_spend_per_hour_stroops",
    help: "Relayer fee spend per hour over the monitoring window, in stroops.",
    registers: [this.registry],
  });
  private readonly relayerAlertTier = new Gauge({
    name: "refract_relayer_alert_tier",
    help: "Relayer balance alert tier: 0=ok, 1=warning, 2=critical, 3=exhausted.",
    registers: [this.registry],
  });
  private readonly relayerFeesTotal = new Counter<"outcome">({
    name: "refract_relayer_fees_paid_stroops_total",
    help: "Fees charged to the relayer, in stroops, by transaction outcome.",
    labelNames: ["outcome"],
    registers: [this.registry],
  });
  private readonly relayerTxFee = new Histogram({
    name: "refract_relayer_tx_fee_stroops",
    help: "Fee charged per relayer-submitted transaction, in stroops.",
    buckets: [100, 1_000, 10_000, 50_000, 100_000, 500_000, 1_000_000, 5_000_000, 10_000_000],
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

  recordOracleStage(feed: string, stage: string, durationSeconds: number): void {
    this.oracleStageDuration.labels({ feed, stage }).observe(durationSeconds);
  }

  recordOracleDeadlineBreach(feed: string, stage: string, overrunSeconds: number): void {
    const labels = { feed, stage };
    this.oracleDeadlineBreaches.labels(labels).inc();
    this.oracleDeadlineOverrun.labels(labels).observe(Math.max(0, overrunSeconds));
  }

  recordOpenDisputes(count: number): void {
    this.openDisputes.set(count);
  }

  recordRelayerBalance(a: BalanceAssessment, spend: FeeSpendSummary): void {
    this.relayerBalance.set(Number(a.balanceStroops));
    this.relayerSpendable.set(Number(a.spendableStroops));
    this.relayerRunwayHours.set(a.runwayHours ?? -1);
    this.relayerRunwaySubmissions.set(a.runwaySubmissions ?? -1);
    this.relayerFeeRate.set(spend.ratePerHourStroops);
    this.relayerAlertTier.set(tierRank(a.tier));
  }

  recordRelayerFee(feeStroops: bigint, successful: boolean): void {
    const fee = Number(feeStroops);
    this.relayerFeesTotal.labels({ outcome: successful ? "success" : "failure" }).inc(fee);
    this.relayerTxFee.observe(fee);
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
