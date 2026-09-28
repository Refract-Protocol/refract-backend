import { MetricsService } from "./metrics.service";
import { Test } from "@nestjs/testing";
import { HealthModule } from "../health/health.module";
import { MetricsModule } from "./metrics.module";
import request from "supertest";

describe("MetricsService", () => {
  it("exports scheduler, Soroban RPC, and oracle counters and durations", async () => {
    const metrics = new MetricsService();
    metrics.recordSchedulerRun("claim_settlement", "success", 1.2);
    metrics.recordOracleCheck("StablecoinDepeg", "failure", 0.3);
    await metrics.observeSorobanRpc("send_transaction", async () => "hash");

    const output = await metrics.metrics();

    expect(output).toContain('refract_scheduler_runs_total{scheduler="claim_settlement",outcome="success"} 1');
    expect(output).toContain('refract_scheduler_run_duration_seconds_count{scheduler="claim_settlement"} 1');
    expect(output).toContain('refract_oracle_checks_total{coverage_type="StablecoinDepeg",outcome="failure"} 1');
    expect(output).toContain('refract_oracle_check_duration_seconds_count{coverage_type="StablecoinDepeg"} 1');
    expect(output).toContain('refract_soroban_rpc_duration_seconds_count{operation="send_transaction",outcome="success"} 1');
  });

  it("records failed Soroban RPC calls and rethrows the original error", async () => {
    const metrics = new MetricsService();
    const rpcError = new Error("RPC unavailable");

    await expect(metrics.observeSorobanRpc("get_account", async () => Promise.reject(rpcError))).rejects.toBe(rpcError);
    expect(await metrics.metrics()).toContain(
      'refract_soroban_rpc_duration_seconds_count{operation="get_account",outcome="failure"} 1'
    );
  });

  it("serves Prometheus text at /metrics and records other HTTP requests", async () => {
    const module = await Test.createTestingModule({
      imports: [HealthModule, MetricsModule],
    }).compile();
    const app = module.createNestApplication();
    const metrics = app.get(MetricsService);
    app.use(metrics.httpMiddleware);
    await app.init();

    try {
      await request(app.getHttpServer()).get("/health").expect(200);
      const response = await request(app.getHttpServer()).get("/metrics").expect(200);

      expect(response.headers["content-type"]).toContain("text/plain");
      expect(response.text).toContain('refract_http_requests_total{method="GET",route="/health",status_code="200"} 1');
      expect(response.text).not.toContain('route="/metrics"');
    } finally {
      await app.close();
    }
  });
});
