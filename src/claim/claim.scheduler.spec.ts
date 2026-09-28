import { ClaimScheduler } from "./claim.scheduler";
import { ClaimService } from "./claim.service";
import { ClaimResult } from "./claim-result";
import { MetricsService } from "../metrics/metrics.service";

function buildResult(overrides: Partial<ClaimResult> = {}): ClaimResult {
  return {
    policyId: "policy-1",
    holder: "GHOLDER",
    coverageType: 0,
    triggered: true,
    payout: "1000000000",
    reason: "USDC price: $0.9000",
    processedAt: Date.now(),
    settlementTxHash: "mock-tx-hash",
    ...overrides,
  };
}

describe("ClaimScheduler", () => {
  describe("scanAndSettle", () => {
    it("calls processTriggered() and does not throw when it settles claims", async () => {
      const claimService = {
        processTriggered: jest.fn().mockResolvedValue([buildResult()]),
      } as unknown as jest.Mocked<ClaimService>;
      const metrics = new MetricsService();
      const scheduler = new ClaimScheduler(claimService, metrics);

      await scheduler.scanAndSettle();

      expect(claimService.processTriggered).toHaveBeenCalledTimes(1);
      expect(await metrics.metrics()).toContain(
        'refract_scheduler_runs_total{scheduler="claim_settlement",outcome="success"} 1'
      );
    });

    it("does not throw when nothing settles this tick", async () => {
      const claimService = {
        processTriggered: jest.fn().mockResolvedValue([]),
      } as unknown as jest.Mocked<ClaimService>;
      const scheduler = new ClaimScheduler(claimService, new MetricsService());

      await expect(scheduler.scanAndSettle()).resolves.toBeUndefined();
    });

    it("catches and logs an error from processTriggered() instead of throwing", async () => {
      const claimService = {
        processTriggered: jest.fn().mockRejectedValue(new Error("oracle sources unreachable")),
      } as unknown as jest.Mocked<ClaimService>;
      const metrics = new MetricsService();
      const scheduler = new ClaimScheduler(claimService, metrics);

      await expect(scheduler.scanAndSettle()).resolves.toBeUndefined();
      expect(await metrics.metrics()).toContain(
        'refract_scheduler_runs_total{scheduler="claim_settlement",outcome="failure"} 1'
      );
    });
  });
});
