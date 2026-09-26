import { ClaimScheduler } from "./claim.scheduler";
import { ClaimService } from "./claim.service";
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

function buildClaimServiceMock(overrides: Partial<jest.Mocked<ClaimService>> = {}) {
  return {
    processTriggered: jest.fn().mockResolvedValue([buildResult()]),
    tryBeginScan: jest.fn().mockReturnValue(true),
    endScan: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<ClaimService>;
}

describe("ClaimScheduler", () => {
  describe("scanAndSettle", () => {
    it("calls processTriggered() and does not throw when it settles claims", async () => {
      const claimService = buildClaimServiceMock();
      const scheduler = new ClaimScheduler(claimService);

      await scheduler.scanAndSettle();

      expect(claimService.tryBeginScan).toHaveBeenCalledTimes(1);
      expect(claimService.processTriggered).toHaveBeenCalledTimes(1);
      expect(claimService.endScan).toHaveBeenCalledTimes(1);
    });

    it("does not throw when nothing settles this tick", async () => {
      const claimService = buildClaimServiceMock({
        processTriggered: jest.fn().mockResolvedValue([]),
      });
      const scheduler = new ClaimScheduler(claimService);

      await expect(scheduler.scanAndSettle()).resolves.toBeUndefined();
      expect(claimService.endScan).toHaveBeenCalledTimes(1);
    });

    it("skips the tick when tryBeginScan returns false (overlapping scan)", async () => {
      const claimService = buildClaimServiceMock({
        tryBeginScan: jest.fn().mockReturnValue(false),
      });
      const scheduler = new ClaimScheduler(claimService);

      await scheduler.scanAndSettle();

      expect(claimService.processTriggered).not.toHaveBeenCalled();
      expect(claimService.endScan).not.toHaveBeenCalled();
    });

    it("catches and logs an error from processTriggered() instead of throwing", async () => {
      const claimService = buildClaimServiceMock({
        processTriggered: jest.fn().mockRejectedValue(new Error("oracle sources unreachable")),
      });
      const scheduler = new ClaimScheduler(claimService);

      await expect(scheduler.scanAndSettle()).resolves.toBeUndefined();
      expect(claimService.endScan).toHaveBeenCalledTimes(1);
    });
  });
});
