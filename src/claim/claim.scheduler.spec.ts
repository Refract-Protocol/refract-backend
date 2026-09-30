import { ClaimScheduler } from "./claim.scheduler";
import { ClaimService, ScanOutcome } from "./claim.service";
import { ClaimResult } from "./claim-result";

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

function emptyCounts(overrides: Partial<ScanOutcome["counts"]> = {}): ScanOutcome["counts"] {
  return {
    scanned: 0,
    triggered: 0,
    settled: 0,
    deferred: 0,
    failedTransient: 0,
    failedPermanent: 0,
    failedIndeterminate: 0,
    deadLettered: 0,
    ...overrides,
  };
}

describe("ClaimScheduler", () => {
  describe("scanAndSettle", () => {
    it("calls processTriggeredWithStats() and does not throw when it settles claims", async () => {
      const claimService = {
        processTriggeredWithStats: jest.fn().mockResolvedValue({
          settled: [buildResult()],
          counts: emptyCounts({ scanned: 1, triggered: 1, settled: 1 }),
        }),
      } as unknown as jest.Mocked<ClaimService>;
      const scheduler = new ClaimScheduler(claimService);

      await scheduler.scanAndSettle();

      expect(claimService.processTriggeredWithStats).toHaveBeenCalledTimes(1);
    });

    it("logs all-failed scans with classification counts", async () => {
      const claimService = {
        processTriggeredWithStats: jest.fn().mockResolvedValue({
          settled: [],
          counts: emptyCounts({
            scanned: 2,
            triggered: 2,
            failedTransient: 1,
            failedPermanent: 1,
            deadLettered: 1,
          }),
        }),
      } as unknown as jest.Mocked<ClaimService>;
      const scheduler = new ClaimScheduler(claimService);
      const logSpy = jest.spyOn((scheduler as unknown as { logger: { log: (m: string) => void } }).logger, "log");

      await scheduler.scanAndSettle();

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("transient=1"));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("deadLettered=1"));
    });

    it("does not throw when nothing settles this tick", async () => {
      const claimService = {
        processTriggeredWithStats: jest.fn().mockResolvedValue({
          settled: [],
          counts: emptyCounts({ scanned: 0 }),
        }),
      } as unknown as jest.Mocked<ClaimService>;
      const scheduler = new ClaimScheduler(claimService);

      await expect(scheduler.scanAndSettle()).resolves.toBeUndefined();
    });

    it("catches and logs an error from processTriggeredWithStats() instead of throwing", async () => {
      const claimService = {
        processTriggeredWithStats: jest.fn().mockRejectedValue(new Error("oracle sources unreachable")),
      } as unknown as jest.Mocked<ClaimService>;
      const scheduler = new ClaimScheduler(claimService);

      await expect(scheduler.scanAndSettle()).resolves.toBeUndefined();
    });
  });
});
