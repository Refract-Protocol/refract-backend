import { ClaimService } from "./claim.service";
import { PolicyService, StoredPolicy } from "../policy/policy.service";
import { OracleService } from "../oracle/oracle.service";
import { OracleReading } from "../oracle/oracle-reading";

function buildPolicy(overrides: Partial<StoredPolicy> = {}): StoredPolicy {
  return {
    id: "policy-1",
    holder: "GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ12",
    coverageType: 0,
    coverageTypeName: "Stablecoin Depeg",
    coverageAmount: "1000000000",
    premium: "3000000",
    durationDays: 30,
    expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    isActive: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function buildReading(overrides: Partial<OracleReading> = {}): OracleReading {
  return {
    coverageType: "StablecoinDepeg",
    type: "oracle_update",
    value: 1.0,
    threshold: 0.95,
    severity: "low",
    message: "USDC price: $1.0000",
    ...overrides,
  };
}

function buildServices() {
  const policyService = {
    listActive: jest.fn().mockReturnValue([]),
    deactivate: jest.fn(),
  } as unknown as jest.Mocked<PolicyService>;

  const oracleService = {
    checkStablecoinDepeg: jest.fn(),
    checkMarketCrash: jest.fn(),
    checkLiquidationShield: jest.fn(),
    checkSmartContractRisk: jest.fn(),
    checkFlightDelay: jest.fn(),
  } as unknown as jest.Mocked<OracleService>;

  return { policyService, oracleService };
}

describe("ClaimService", () => {
  describe("processTriggered", () => {
    it("returns an empty array and touches no oracle when there are no active policies", async () => {
      const { policyService, oracleService } = buildServices();
      policyService.listActive.mockReturnValue([]);
      const service = new ClaimService(policyService, oracleService);

      const results = await service.processTriggered();

      expect(results).toEqual([]);
      expect(oracleService.checkStablecoinDepeg).not.toHaveBeenCalled();
    });

    it.each([
      [0, "checkStablecoinDepeg"],
      [1, "checkMarketCrash"],
      [2, "checkLiquidationShield"],
      [3, "checkSmartContractRisk"],
    ] as const)("routes coverageType %d to OracleService.%s", async (coverageType, method) => {
      const { policyService, oracleService } = buildServices();
      policyService.listActive.mockReturnValue([buildPolicy({ coverageType })]);
      oracleService[method].mockResolvedValue(buildReading({ value: 1, threshold: 0.5 }));
      const service = new ClaimService(policyService, oracleService);

      await service.processTriggered();

      expect(oracleService[method]).toHaveBeenCalledTimes(1);
    });

    it("routes coverageType 4 (FlightDelay) to OracleService.checkFlightDelay with a placeholder flight number", async () => {
      const { policyService, oracleService } = buildServices();
      policyService.listActive.mockReturnValue([buildPolicy({ coverageType: 4 })]);
      oracleService.checkFlightDelay.mockResolvedValue(buildReading({ value: 0, threshold: 120 }));
      const service = new ClaimService(policyService, oracleService);

      await service.processTriggered();

      expect(oracleService.checkFlightDelay).toHaveBeenCalledWith("UNKNOWN");
    });

    it("triggers and pays out a below-threshold policy (StablecoinDepeg-style)", async () => {
      const { policyService, oracleService } = buildServices();
      const policy = buildPolicy({ coverageType: 0, coverageAmount: "5000000000" });
      policyService.listActive.mockReturnValue([policy]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      const service = new ClaimService(policyService, oracleService);

      const results = await service.processTriggered();

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        policyId: policy.id,
        holder: policy.holder,
        triggered: true,
        payout: "5000000000",
      });
      expect(policyService.deactivate).toHaveBeenCalledWith(policy.id);
    });

    it("triggers a FlightDelay policy when the delay exceeds threshold (inverted comparison)", async () => {
      const { policyService, oracleService } = buildServices();
      const policy = buildPolicy({ coverageType: 4, coverageAmount: "20000000" });
      policyService.listActive.mockReturnValue([policy]);
      oracleService.checkFlightDelay.mockResolvedValue(buildReading({ value: 180, threshold: 120 }));
      const service = new ClaimService(policyService, oracleService);

      const results = await service.processTriggered();

      expect(results).toHaveLength(1);
      expect(results[0].triggered).toBe(true);
      expect(results[0].payout).toBe("20000000");
    });

    it("does not trigger or deactivate when the oracle reading is on the non-triggering side", async () => {
      const { policyService, oracleService } = buildServices();
      const policy = buildPolicy({ coverageType: 0 });
      policyService.listActive.mockReturnValue([policy]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 1.0, threshold: 0.95 }));
      const service = new ClaimService(policyService, oracleService);

      const results = await service.processTriggered();

      expect(results).toEqual([]);
      expect(policyService.deactivate).not.toHaveBeenCalled();
    });

    it("skips a stale oracle reading without triggering, even if the value would otherwise trigger", async () => {
      const { policyService, oracleService } = buildServices();
      const policy = buildPolicy({ coverageType: 0 });
      policyService.listActive.mockReturnValue([policy]);

      // Date.now() is called more than once per scan (fetchedAt capture,
      // Nest's logger, the staleness check, processedAt) with no hook to
      // isolate just the staleness comparison. So instead of counting
      // calls, pin Date.now() to a fixed instant and jump it forward only
      // once the oracle promise resolves — after that point every
      // Date.now() call (including the staleness check) sees "later".
      const baseMs = Date.now();
      const dateNowSpy = jest.spyOn(Date, "now").mockReturnValue(baseMs);
      oracleService.checkStablecoinDepeg.mockImplementation(async () => {
        dateNowSpy.mockReturnValue(baseMs + 3600_000); // 1h later, past STALENESS_LIMIT_SECONDS
        return buildReading({ value: 0.5, threshold: 0.95 });
      });

      const service = new ClaimService(policyService, oracleService);
      const results = await service.processTriggered();

      expect(results).toEqual([]);
      expect(policyService.deactivate).not.toHaveBeenCalled();

      dateNowSpy.mockRestore();
    });

    it("logs and continues past a policy with an unknown coverageType, still processing the rest", async () => {
      const { policyService, oracleService } = buildServices();
      const badPolicy = buildPolicy({ id: "bad-policy", coverageType: 99 });
      const goodPolicy = buildPolicy({ id: "good-policy", coverageType: 0 });
      policyService.listActive.mockReturnValue([badPolicy, goodPolicy]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      const service = new ClaimService(policyService, oracleService);

      const results = await service.processTriggered();

      expect(results).toHaveLength(1);
      expect(results[0].policyId).toBe("good-policy");
    });
  });

  describe("getStats", () => {
    it("aggregates active policy count, processed claims, and total payout", async () => {
      const { policyService, oracleService } = buildServices();
      const policy = buildPolicy({ coverageType: 0, coverageAmount: "7000000000" });
      policyService.listActive.mockReturnValue([policy]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      const service = new ClaimService(policyService, oracleService);

      await service.processTriggered();
      policyService.listActive.mockReturnValue([]); // policy is now inactive post-payout

      const stats = service.getStats();

      expect(stats.activePolicies).toBe(0);
      expect(stats.processedClaims).toBe(1);
      expect(stats.totalPayout).toBe("7000000000");
    });
  });
});
