import { ConfigService } from "@nestjs/config";
import { ClaimService } from "./claim.service";
import { PolicyService, StoredPolicy } from "../policy/policy.service";
import { OracleService } from "../oracle/oracle.service";
import { OracleReading } from "../oracle/oracle-reading";
import { ClaimSettlementService, SettlementResult } from "./claim-settlement.service";
import { AppConfig } from "../config/configuration";

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

function buildConfigService(overrides: Partial<AppConfig["claims"]> = {}): ConfigService<AppConfig, true> {
  const claims: AppConfig["claims"] = {
    scanConcurrency: 8,
    payoutMismatchTolerance: "0",
    ...overrides,
  };
  return {
    get: jest.fn((key: string) => (key === "claims" ? claims : undefined)),
  } as unknown as ConfigService<AppConfig, true>;
}

function buildServices(claimsOverrides?: Partial<AppConfig["claims"]>) {
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

  const claimSettlementService = {
    settleClaim: jest.fn().mockImplementation((_id: string, _holder: string, payout: bigint) =>
      Promise.resolve({
        settled: true,
        txHash: "mock-tx-hash",
        actualPayout: payout,
      } satisfies SettlementResult)
    ),
    isConfigured: jest.fn().mockReturnValue(true),
  } as unknown as jest.Mocked<ClaimSettlementService>;

  const configService = buildConfigService(claimsOverrides);

  return { policyService, oracleService, claimSettlementService, configService };
}

function createService(
  policyService: PolicyService,
  oracleService: OracleService,
  claimSettlementService: ClaimSettlementService,
  configService: ConfigService<AppConfig, true>
): ClaimService {
  return new ClaimService(policyService, oracleService, claimSettlementService, configService);
}

describe("ClaimService", () => {
  describe("tryBeginScan", () => {
    it("skips overlapping scans until endScan clears the guard", () => {
      const { policyService, oracleService, claimSettlementService, configService } = buildServices();
      const service = createService(policyService, oracleService, claimSettlementService, configService);

      expect(service.tryBeginScan()).toBe(true);
      expect(service.isScanInFlight()).toBe(true);
      expect(service.tryBeginScan()).toBe(false);
      service.endScan();
      expect(service.isScanInFlight()).toBe(false);
      expect(service.tryBeginScan()).toBe(true);
      service.endScan();
    });
  });

  describe("processTriggered", () => {
    it("returns an empty array and touches no oracle when there are no active policies", async () => {
      const { policyService, oracleService, claimSettlementService, configService } = buildServices();
      policyService.listActive.mockReturnValue([]);
      const service = createService(policyService, oracleService, claimSettlementService, configService);

      const results = await service.processTriggered();

      expect(results).toEqual([]);
      expect(oracleService.checkStablecoinDepeg).not.toHaveBeenCalled();
      expect(service.getLastScanStats()).toMatchObject({
        policiesExamined: 0,
        settled: 0,
      });
    });

    it.each([
      [0, "checkStablecoinDepeg"],
      [1, "checkMarketCrash"],
      [2, "checkLiquidationShield"],
      [3, "checkSmartContractRisk"],
    ] as const)("routes coverageType %d to OracleService.%s", async (coverageType, method) => {
      const { policyService, oracleService, claimSettlementService, configService } = buildServices();
      policyService.listActive.mockReturnValue([buildPolicy({ coverageType })]);
      oracleService[method].mockResolvedValue(buildReading({ value: 1, threshold: 0.5 }));
      const service = createService(policyService, oracleService, claimSettlementService, configService);

      await service.processTriggered();

      expect(oracleService[method]).toHaveBeenCalledTimes(1);
    });

    it("falls back to a placeholder flight number when the policy has no triggerParams", async () => {
      const { policyService, oracleService, claimSettlementService, configService } = buildServices();
      policyService.listActive.mockReturnValue([buildPolicy({ coverageType: 4 })]);
      oracleService.checkFlightDelay.mockResolvedValue(buildReading({ value: 0, threshold: 120 }));
      const service = createService(policyService, oracleService, claimSettlementService, configService);

      await service.processTriggered();

      expect(oracleService.checkFlightDelay).toHaveBeenCalledWith("UNKNOWN");
    });

    it("routes coverageType 4 (FlightDelay) to OracleService.checkFlightDelay using the buy-time flight number", async () => {
      const { policyService, oracleService, claimSettlementService, configService } = buildServices();
      policyService.listActive.mockReturnValue([
        buildPolicy({ coverageType: 4, triggerParams: { flightNumber: "BA249" } }),
      ]);
      oracleService.checkFlightDelay.mockResolvedValue(buildReading({ value: 0, threshold: 120 }));
      const service = createService(policyService, oracleService, claimSettlementService, configService);

      await service.processTriggered();

      expect(oracleService.checkFlightDelay).toHaveBeenCalledWith("BA249");
    });

    it("triggers, settles on-chain, and pays out a below-threshold policy (StablecoinDepeg-style)", async () => {
      const { policyService, oracleService, claimSettlementService, configService } = buildServices();
      const policy = buildPolicy({ coverageType: 0, coverageAmount: "5000000000" });
      policyService.listActive.mockReturnValue([policy]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      const service = createService(policyService, oracleService, claimSettlementService, configService);

      const results = await service.processTriggered();

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        policyId: policy.id,
        holder: policy.holder,
        triggered: true,
        payout: "5000000000",
        settlementTxHash: "mock-tx-hash",
      });
      expect(claimSettlementService.settleClaim).toHaveBeenCalledWith(policy.id, policy.holder, 5_000_000_000n);
      expect(policyService.deactivate).toHaveBeenCalledWith(policy.id);
    });

    it("triggers a FlightDelay policy when the delay exceeds threshold (inverted comparison)", async () => {
      const { policyService, oracleService, claimSettlementService, configService } = buildServices();
      const policy = buildPolicy({ coverageType: 4, coverageAmount: "20000000" });
      policyService.listActive.mockReturnValue([policy]);
      oracleService.checkFlightDelay.mockResolvedValue(buildReading({ value: 180, threshold: 120 }));
      const service = createService(policyService, oracleService, claimSettlementService, configService);

      const results = await service.processTriggered();

      expect(results).toHaveLength(1);
      expect(results[0].triggered).toBe(true);
      expect(results[0].payout).toBe("20000000");
    });

    it("does not trigger or deactivate when the oracle reading is on the non-triggering side", async () => {
      const { policyService, oracleService, claimSettlementService, configService } = buildServices();
      const policy = buildPolicy({ coverageType: 0 });
      policyService.listActive.mockReturnValue([policy]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 1.0, threshold: 0.95 }));
      const service = createService(policyService, oracleService, claimSettlementService, configService);

      const results = await service.processTriggered();

      expect(results).toEqual([]);
      expect(claimSettlementService.settleClaim).not.toHaveBeenCalled();
      expect(policyService.deactivate).not.toHaveBeenCalled();
    });

    it("does not deactivate or count a claim whose on-chain settlement fails to confirm", async () => {
      const { policyService, oracleService, claimSettlementService, configService } = buildServices();
      const policy = buildPolicy({ coverageType: 0, coverageAmount: "5000000000" });
      policyService.listActive.mockReturnValue([policy]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      claimSettlementService.settleClaim.mockResolvedValue({ settled: false, error: "Transaction failed on-chain" });
      const service = createService(policyService, oracleService, claimSettlementService, configService);

      const results = await service.processTriggered();

      expect(results).toEqual([]);
      expect(policyService.deactivate).not.toHaveBeenCalled();
      expect(service.getStats().processedClaims).toBe(0);
    });

    it("skips a stale oracle reading without triggering, even if the value would otherwise trigger", async () => {
      const { policyService, oracleService, claimSettlementService, configService } = buildServices();
      const policy = buildPolicy({ coverageType: 0 });
      policyService.listActive.mockReturnValue([policy]);

      const baseMs = Date.now();
      const dateNowSpy = jest.spyOn(Date, "now").mockReturnValue(baseMs);
      oracleService.checkStablecoinDepeg.mockImplementation(async () => {
        dateNowSpy.mockReturnValue(baseMs + 3600_000);
        return buildReading({ value: 0.5, threshold: 0.95 });
      });

      const service = createService(policyService, oracleService, claimSettlementService, configService);
      const results = await service.processTriggered();

      expect(results).toEqual([]);
      expect(policyService.deactivate).not.toHaveBeenCalled();

      dateNowSpy.mockRestore();
    });

    it("logs and continues past a policy with an unknown coverageType, still processing the rest", async () => {
      const { policyService, oracleService, claimSettlementService, configService } = buildServices();
      const badPolicy = buildPolicy({ id: "bad-policy", coverageType: 99 });
      const goodPolicy = buildPolicy({ id: "good-policy", coverageType: 0 });
      policyService.listActive.mockReturnValue([badPolicy, goodPolicy]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      const service = createService(policyService, oracleService, claimSettlementService, configService);

      const results = await service.processTriggered();

      expect(results).toHaveLength(1);
      expect(results[0].policyId).toBe("good-policy");
    });

    it("never exceeds scanConcurrency during oracle fetches", async () => {
      const { policyService, oracleService, claimSettlementService, configService } = buildServices({
        scanConcurrency: 2,
      });
      const policies = Array.from({ length: 10 }, (_, i) =>
        buildPolicy({ id: `policy-${i}`, coverageType: 0, coverageAmount: "1000000000" })
      );
      policyService.listActive.mockReturnValue(policies);

      let inFlight = 0;
      let maxInFlight = 0;
      oracleService.checkStablecoinDepeg.mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 25));
        inFlight--;
        return buildReading({ value: 0.9, threshold: 0.95 });
      });

      const service = createService(policyService, oracleService, claimSettlementService, configService);
      await service.processTriggered();

      expect(maxInFlight).toBeLessThanOrEqual(2);
    });

    it("shares one oracle call per coverage type across policies", async () => {
      const { policyService, oracleService, claimSettlementService, configService } = buildServices();
      const policies = Array.from({ length: 5 }, (_, i) =>
        buildPolicy({ id: `policy-${i}`, coverageType: 0, coverageAmount: "1000000000" })
      );
      policyService.listActive.mockReturnValue(policies);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      const service = createService(policyService, oracleService, claimSettlementService, configService);

      await service.processTriggered();

      expect(oracleService.checkStablecoinDepeg).toHaveBeenCalledTimes(1);
      expect(claimSettlementService.settleClaim).toHaveBeenCalledTimes(5);
    });

    it("records payout discrepancies when actual differs beyond tolerance", async () => {
      const { policyService, oracleService, claimSettlementService, configService } = buildServices({
        payoutMismatchTolerance: "0",
      });
      const policy = buildPolicy({ coverageType: 0, coverageAmount: "5000000000" });
      policyService.listActive.mockReturnValue([policy]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      claimSettlementService.settleClaim.mockResolvedValue({
        settled: true,
        txHash: "mock-tx-hash",
        actualPayout: 4_999_000_000n,
      });
      const service = createService(policyService, oracleService, claimSettlementService, configService);

      const results = await service.processTriggered();

      expect(results[0].payoutDiscrepancy).toBe(true);
      expect(service.getPayoutDiscrepancies()).toHaveLength(1);
      expect(service.getPayoutDiscrepancies()[0].actualPayout).toBe("4999000000");
    });

    it("aggregates last-scan stats after a mixed scan", async () => {
      const { policyService, oracleService, claimSettlementService, configService } = buildServices();
      const trigger = buildPolicy({ id: "trigger", coverageType: 0, coverageAmount: "1000000000" });
      const quiet = buildPolicy({ id: "quiet", coverageType: 1, coverageAmount: "1000000000" });
      policyService.listActive.mockReturnValue([trigger, quiet]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      oracleService.checkMarketCrash.mockResolvedValue(buildReading({ value: 1.0, threshold: 0.5 }));

      const service = createService(policyService, oracleService, claimSettlementService, configService);
      await service.processTriggered();

      expect(service.getLastScanStats()).toMatchObject({
        policiesExamined: 2,
        triggered: 1,
        settled: 1,
        failed: 0,
      });
    });
  });

  describe("getStats", () => {
    it("aggregates active policy count, processed claims, and total payout", async () => {
      const { policyService, oracleService, claimSettlementService, configService } = buildServices();
      const policy = buildPolicy({ coverageType: 0, coverageAmount: "7000000000" });
      policyService.listActive.mockReturnValue([policy]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      const service = createService(policyService, oracleService, claimSettlementService, configService);

      await service.processTriggered();
      policyService.listActive.mockReturnValue([]);

      const stats = service.getStats();

      expect(stats.activePolicies).toBe(0);
      expect(stats.processedClaims).toBe(1);
      expect(stats.totalPayout).toBe("7000000000");
    });

    it("uses on-chain actualPayout for totals when it differs from expected", async () => {
      const { policyService, oracleService, claimSettlementService, configService } = buildServices({
        payoutMismatchTolerance: "1000000000",
      });
      const policy = buildPolicy({ coverageType: 0, coverageAmount: "7000000000" });
      policyService.listActive.mockReturnValue([policy]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      claimSettlementService.settleClaim.mockResolvedValue({
        settled: true,
        txHash: "mock-tx-hash",
        actualPayout: 6_500_000_000n,
      });
      const service = createService(policyService, oracleService, claimSettlementService, configService);

      await service.processTriggered();

      expect(service.getStats().totalPayout).toBe("6500000000");
    });

    it("reflects ClaimSettlementService.isConfigured()", () => {
      const { policyService, oracleService, claimSettlementService, configService } = buildServices();
      claimSettlementService.isConfigured.mockReturnValue(false);
      const service = createService(policyService, oracleService, claimSettlementService, configService);

      expect(service.getStats().settlementConfigured).toBe(false);
    });
  });

  describe("getHistoryForHolder", () => {
    it("returns only settled claims for the given holder, most recent first", async () => {
      const { policyService, oracleService, claimSettlementService, configService } = buildServices();
      const alice = buildPolicy({ id: "policy-alice", holder: "GALICE", coverageType: 0 });
      const bob = buildPolicy({ id: "policy-bob", holder: "GBOB", coverageType: 0 });
      policyService.listActive.mockReturnValue([alice, bob]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      const service = createService(policyService, oracleService, claimSettlementService, configService);

      await service.processTriggered();

      const aliceHistory = service.getHistoryForHolder("GALICE");
      expect(aliceHistory).toHaveLength(1);
      expect(aliceHistory[0].policyId).toBe("policy-alice");
    });

    it("returns an empty array for a holder with no settled claims", () => {
      const { policyService, oracleService, claimSettlementService, configService } = buildServices();
      const service = createService(policyService, oracleService, claimSettlementService, configService);

      expect(service.getHistoryForHolder("GNOBODY")).toEqual([]);
    });

    it("excludes claims that were evaluated but didn't trigger", async () => {
      const { policyService, oracleService, claimSettlementService, configService } = buildServices();
      const policy = buildPolicy({ holder: "GALICE", coverageType: 0 });
      policyService.listActive.mockReturnValue([policy]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 1.0, threshold: 0.95 }));
      const service = createService(policyService, oracleService, claimSettlementService, configService);

      await service.processTriggered();

      expect(service.getHistoryForHolder("GALICE")).toEqual([]);
    });
  });

  describe("getRecentSettlements", () => {
    it("returns settled claims across all holders, most recent first", async () => {
      const { policyService, oracleService, claimSettlementService, configService } = buildServices();
      const alice = buildPolicy({ id: "policy-alice", holder: "GALICE", coverageType: 0 });
      const bob = buildPolicy({ id: "policy-bob", holder: "GBOB", coverageType: 0 });
      policyService.listActive.mockReturnValue([alice, bob]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      const service = createService(policyService, oracleService, claimSettlementService, configService);

      await service.processTriggered();

      const recent = service.getRecentSettlements();
      expect(recent.map((c) => c.policyId).sort()).toEqual(["policy-alice", "policy-bob"]);
    });

    it("caps results at the given limit", async () => {
      const { policyService, oracleService, claimSettlementService, configService } = buildServices();
      const policies = Array.from({ length: 5 }, (_, i) =>
        buildPolicy({ id: `policy-${i}`, holder: `GHOLDER${i}`, coverageType: 0 })
      );
      policyService.listActive.mockReturnValue(policies);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      const service = createService(policyService, oracleService, claimSettlementService, configService);

      await service.processTriggered();

      expect(service.getRecentSettlements(2)).toHaveLength(2);
    });

    it("returns an empty array when nothing has settled yet", () => {
      const { policyService, oracleService, claimSettlementService, configService } = buildServices();
      const service = createService(policyService, oracleService, claimSettlementService, configService);

      expect(service.getRecentSettlements()).toEqual([]);
    });
  });
});
