import { ConfigService } from "@nestjs/config";
import { AlertingService } from "../alerting/alerting.service";
import { AppConfig } from "../config/configuration";
import { ClaimService } from "./claim.service";
import { PolicyService, StoredPolicy } from "../policy/policy.service";
import { OracleService } from "../oracle/oracle.service";
import { OracleReading } from "../oracle/oracle-reading";
import { ClaimSettlementService, SettlementResult } from "./claim-settlement.service";
import { SorobanRpcService } from "../stellar/soroban-rpc.service";
import { rpc } from "@stellar/stellar-sdk";

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
    onChainPolicyId: "42",
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

function buildConfig(): ConfigService<AppConfig, true> {
  const settlement: AppConfig["settlement"] = {
    maxAttempts: 3,
    maxAgeMs: 60_000,
    backoffBaseMs: 1_000,
    failureRateAlertThreshold: 0.5,
  };
  const stellar = {
    network: "testnet",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    poolContractId: "",
    policyContractId: "",
    oracleContractId: "",
    relayerSecret: "",
  };
  return {
    get: jest.fn((key: string) => (key === "settlement" ? settlement : stellar)),
  } as unknown as ConfigService<AppConfig, true>;
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

  const claimSettlementService = {
    settleClaim: jest.fn().mockResolvedValue({ settled: true, txHash: "mock-tx-hash" } satisfies SettlementResult),
    isConfigured: jest.fn().mockReturnValue(true),
  } as unknown as jest.Mocked<ClaimSettlementService>;

  const alerting = {
    emit: jest.fn(),
    listRecent: jest.fn().mockReturnValue([]),
  } as unknown as jest.Mocked<AlertingService>;

  const config = buildConfig();
  const rpcService = new SorobanRpcService(config);
  jest.spyOn(rpcService.server, "getTransaction").mockResolvedValue({
    status: rpc.Api.GetTransactionStatus.NOT_FOUND,
  } as never);

  const makeService = () =>
    new ClaimService(policyService, oracleService, claimSettlementService, config, alerting, rpcService);

  return { policyService, oracleService, claimSettlementService, alerting, rpcService, makeService };
}

describe("ClaimService", () => {
  describe("processTriggered", () => {
    it("returns an empty array and touches no oracle when there are no active policies", async () => {
      const { policyService, oracleService, makeService } = buildServices();
      policyService.listActive.mockReturnValue([]);
      const service = makeService();

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
      const { policyService, oracleService, makeService } = buildServices();
      policyService.listActive.mockReturnValue([buildPolicy({ coverageType })]);
      oracleService[method].mockResolvedValue(buildReading({ value: 1, threshold: 0.5 }));
      const service = makeService();

      await service.processTriggered();

      expect(oracleService[method]).toHaveBeenCalledTimes(1);
    });

    it("falls back to a placeholder flight number when the policy has no triggerParams", async () => {
      const { policyService, oracleService, makeService } = buildServices();
      policyService.listActive.mockReturnValue([buildPolicy({ coverageType: 4 })]);
      oracleService.checkFlightDelay.mockResolvedValue(buildReading({ value: 0, threshold: 120 }));
      const service = makeService();

      await service.processTriggered();

      expect(oracleService.checkFlightDelay).toHaveBeenCalledWith("UNKNOWN");
    });

    it("routes coverageType 4 (FlightDelay) to OracleService.checkFlightDelay using the buy-time flight number", async () => {
      const { policyService, oracleService, makeService } = buildServices();
      policyService.listActive.mockReturnValue([
        buildPolicy({ coverageType: 4, triggerParams: { flightNumber: "BA249" } }),
      ]);
      oracleService.checkFlightDelay.mockResolvedValue(buildReading({ value: 0, threshold: 120 }));
      const service = makeService();

      await service.processTriggered();

      expect(oracleService.checkFlightDelay).toHaveBeenCalledWith("BA249");
    });

    it("triggers, settles on-chain, and pays out a below-threshold policy (StablecoinDepeg-style)", async () => {
      const { policyService, oracleService, claimSettlementService, makeService } = buildServices();
      const policy = buildPolicy({ coverageType: 0, coverageAmount: "5000000000", onChainPolicyId: "99" });
      policyService.listActive.mockReturnValue([policy]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      const service = makeService();

      const results = await service.processTriggered();

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        policyId: policy.id,
        holder: policy.holder,
        triggered: true,
        payout: "5000000000",
        settlementTxHash: "mock-tx-hash",
      });
      expect(claimSettlementService.settleClaim).toHaveBeenCalledWith(99n, policy.holder, 5_000_000_000n);
      expect(policyService.deactivate).toHaveBeenCalledWith(policy.id);
    });

    it("triggers a FlightDelay policy when the delay exceeds threshold (inverted comparison)", async () => {
      const { policyService, oracleService, makeService } = buildServices();
      const policy = buildPolicy({ coverageType: 4, coverageAmount: "20000000" });
      policyService.listActive.mockReturnValue([policy]);
      oracleService.checkFlightDelay.mockResolvedValue(buildReading({ value: 180, threshold: 120 }));
      const service = makeService();

      const results = await service.processTriggered();

      expect(results).toHaveLength(1);
      expect(results[0].triggered).toBe(true);
      expect(results[0].payout).toBe("20000000");
    });

    it("does not trigger or deactivate when the oracle reading is on the non-triggering side", async () => {
      const { policyService, oracleService, claimSettlementService, makeService } = buildServices();
      const policy = buildPolicy({ coverageType: 0 });
      policyService.listActive.mockReturnValue([policy]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 1.0, threshold: 0.95 }));
      const service = makeService();

      const results = await service.processTriggered();

      expect(results).toEqual([]);
      expect(claimSettlementService.settleClaim).not.toHaveBeenCalled();
      expect(policyService.deactivate).not.toHaveBeenCalled();
    });

    it("does not deactivate or count a claim whose on-chain settlement fails to confirm", async () => {
      const { policyService, oracleService, claimSettlementService, makeService } = buildServices();
      const policy = buildPolicy({ coverageType: 0, coverageAmount: "5000000000" });
      policyService.listActive.mockReturnValue([policy]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      claimSettlementService.settleClaim.mockResolvedValue({ settled: false, error: "Transaction failed on-chain" });
      const service = makeService();

      const results = await service.processTriggered();

      expect(results).toEqual([]);
      expect(policyService.deactivate).not.toHaveBeenCalled();
      expect(service.getStats().processedClaims).toBe(0);
      expect(service.getAttempt(policy.id)?.attemptCount).toBe(1);
    });

    it("skips a stale oracle reading without triggering, even if the value would otherwise trigger", async () => {
      const { policyService, oracleService, makeService } = buildServices();
      const policy = buildPolicy({ coverageType: 0 });
      policyService.listActive.mockReturnValue([policy]);

      const baseMs = Date.now();
      const dateNowSpy = jest.spyOn(Date, "now").mockReturnValue(baseMs);
      oracleService.checkStablecoinDepeg.mockImplementation(async () => {
        dateNowSpy.mockReturnValue(baseMs + 3600_000);
        return buildReading({ value: 0.5, threshold: 0.95 });
      });

      const service = makeService();
      const results = await service.processTriggered();

      expect(results).toEqual([]);
      expect(policyService.deactivate).not.toHaveBeenCalled();

      dateNowSpy.mockRestore();
    });

    it("logs and continues past a policy with an unknown coverageType, still processing the rest", async () => {
      const { policyService, oracleService, makeService } = buildServices();
      const badPolicy = buildPolicy({ id: "bad-policy", coverageType: 99 });
      const goodPolicy = buildPolicy({ id: "good-policy", coverageType: 0 });
      policyService.listActive.mockReturnValue([badPolicy, goodPolicy]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      const service = makeService();

      const results = await service.processTriggered();

      expect(results).toHaveLength(1);
      expect(results[0].policyId).toBe("good-policy");
    });
  });

  describe("settlement retry budget / dead-letter", () => {
    it("increments and persists attempt count across scans", async () => {
      const { policyService, oracleService, claimSettlementService, makeService } = buildServices();
      const policy = buildPolicy();
      policyService.listActive.mockReturnValue([policy]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      claimSettlementService.settleClaim.mockResolvedValue({ settled: false, error: "connection refused" });
      const service = makeService();

      await service.processTriggered();
      // Force backoff to elapse
      const attempt = service.getAttempt(policy.id)!;
      attempt.lastAttemptAt = Date.now() - 60_000;
      await service.processTriggered();

      expect(service.getAttempt(policy.id)?.attemptCount).toBe(2);
    });

    it("defers a retry when backoff has not elapsed", async () => {
      const { policyService, oracleService, claimSettlementService, makeService } = buildServices();
      const policy = buildPolicy();
      policyService.listActive.mockReturnValue([policy]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      claimSettlementService.settleClaim.mockResolvedValue({ settled: false, error: "connection refused" });
      const service = makeService();

      await service.processTriggered();
      claimSettlementService.settleClaim.mockClear();
      const outcome = await service.processTriggeredWithStats();

      expect(outcome.counts.deferred).toBe(1);
      expect(claimSettlementService.settleClaim).not.toHaveBeenCalled();
    });

    it("dead-letters on budget exhaustion without deactivating the policy", async () => {
      const { policyService, oracleService, claimSettlementService, alerting, makeService } = buildServices();
      const policy = buildPolicy();
      policyService.listActive.mockReturnValue([policy]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      claimSettlementService.settleClaim.mockResolvedValue({ settled: false, error: "connection refused" });
      const service = makeService();

      for (let i = 0; i < 3; i++) {
        const attempt = service.getAttempt(policy.id);
        if (attempt) attempt.lastAttemptAt = Date.now() - 60_000;
        await service.processTriggered();
      }

      const record = service.getAttempt(policy.id)!;
      expect(record.deadLettered).toBe(true);
      expect(policyService.deactivate).not.toHaveBeenCalled();
      expect(alerting.emit).toHaveBeenCalledWith(
        "critical",
        "Claim settlement dead-lettered",
        expect.any(String),
        expect.objectContaining({ policyId: policy.id })
      );
      expect(service.listDeadLettered()).toHaveLength(1);
    });

    it("dead-letters immediately on a permanent-classification error", async () => {
      const { policyService, oracleService, claimSettlementService, makeService } = buildServices();
      const policy = buildPolicy({ onChainPolicyId: undefined });
      policyService.listActive.mockReturnValue([policy]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      const service = makeService();

      await service.processTriggered();

      expect(service.getAttempt(policy.id)?.deadLettered).toBe(true);
      expect(claimSettlementService.settleClaim).not.toHaveBeenCalled();
      expect(policyService.deactivate).not.toHaveBeenCalled();
    });

    it("re-queries a pending tx hash before retrying an indeterminate timeout", async () => {
      const { policyService, oracleService, claimSettlementService, rpcService, makeService } = buildServices();
      const policy = buildPolicy();
      policyService.listActive.mockReturnValue([policy]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      claimSettlementService.settleClaim.mockResolvedValue({
        settled: false,
        error: "Timed out waiting for confirmation",
        txHash: "pending-hash",
      });
      const service = makeService();

      await service.processTriggered();
      expect(service.getAttempt(policy.id)?.pendingTxHash).toBe("pending-hash");

      jest.spyOn(rpcService.server, "getTransaction").mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
      } as never);
      const attempt = service.getAttempt(policy.id)!;
      attempt.lastAttemptAt = Date.now() - 60_000;

      const results = await service.processTriggered();
      expect(results).toHaveLength(1);
      expect(policyService.deactivate).toHaveBeenCalledWith(policy.id);
      expect(claimSettlementService.settleClaim).toHaveBeenCalledTimes(1); // no second submit
    });

    it("requeues a dead-lettered claim via ops action", async () => {
      const { policyService, oracleService, makeService } = buildServices();
      const policy = buildPolicy({ onChainPolicyId: undefined });
      policyService.listActive.mockReturnValue([policy]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      const service = makeService();
      await service.processTriggered();

      const requeued = service.requeueDeadLetter(policy.id);
      expect(requeued.deadLettered).toBe(false);
      expect(requeued.attemptCount).toBe(0);
    });
  });

  describe("getStats", () => {
    it("aggregates active policy count, processed claims, and total payout", async () => {
      const { policyService, oracleService, makeService } = buildServices();
      const policy = buildPolicy({ coverageType: 0, coverageAmount: "7000000000" });
      policyService.listActive.mockReturnValue([policy]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      const service = makeService();

      await service.processTriggered();
      policyService.listActive.mockReturnValue([]);

      const stats = service.getStats();

      expect(stats.activePolicies).toBe(0);
      expect(stats.processedClaims).toBe(1);
      expect(stats.totalPayout).toBe("7000000000");
    });

    it("reflects ClaimSettlementService.isConfigured()", () => {
      const { claimSettlementService, makeService } = buildServices();
      claimSettlementService.isConfigured.mockReturnValue(false);
      const service = makeService();

      expect(service.getStats().settlementConfigured).toBe(false);
    });
  });

  describe("getHistoryForHolder", () => {
    it("returns only settled claims for the given holder, most recent first", async () => {
      const { policyService, oracleService, makeService } = buildServices();
      const alice = buildPolicy({ id: "policy-alice", holder: "GALICE", coverageType: 0 });
      const bob = buildPolicy({ id: "policy-bob", holder: "GBOB", coverageType: 0 });
      policyService.listActive.mockReturnValue([alice, bob]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      const service = makeService();

      await service.processTriggered();

      const aliceHistory = service.getHistoryForHolder("GALICE");
      expect(aliceHistory).toHaveLength(1);
      expect(aliceHistory[0].policyId).toBe("policy-alice");
    });

    it("returns an empty array for a holder with no settled claims", () => {
      const { makeService } = buildServices();
      const service = makeService();

      expect(service.getHistoryForHolder("GNOBODY")).toEqual([]);
    });

    it("excludes claims that were evaluated but didn't trigger", async () => {
      const { policyService, oracleService, makeService } = buildServices();
      const policy = buildPolicy({ holder: "GALICE", coverageType: 0 });
      policyService.listActive.mockReturnValue([policy]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 1.0, threshold: 0.95 }));
      const service = makeService();

      await service.processTriggered();

      expect(service.getHistoryForHolder("GALICE")).toEqual([]);
    });
  });

  describe("getRecentSettlements", () => {
    it("returns settled claims across all holders, most recent first", async () => {
      const { policyService, oracleService, makeService } = buildServices();
      const alice = buildPolicy({ id: "policy-alice", holder: "GALICE", coverageType: 0 });
      const bob = buildPolicy({ id: "policy-bob", holder: "GBOB", coverageType: 0 });
      policyService.listActive.mockReturnValue([alice, bob]);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      const service = makeService();

      await service.processTriggered();

      const recent = service.getRecentSettlements();
      expect(recent.map((c) => c.policyId).sort()).toEqual(["policy-alice", "policy-bob"]);
    });

    it("caps results at the given limit", async () => {
      const { policyService, oracleService, makeService } = buildServices();
      const policies = Array.from({ length: 5 }, (_, i) =>
        buildPolicy({ id: `policy-${i}`, holder: `GHOLDER${i}`, coverageType: 0 })
      );
      policyService.listActive.mockReturnValue(policies);
      oracleService.checkStablecoinDepeg.mockResolvedValue(buildReading({ value: 0.9, threshold: 0.95 }));
      const service = makeService();

      await service.processTriggered();

      expect(service.getRecentSettlements(2)).toHaveLength(2);
    });

    it("returns an empty array when nothing has settled yet", () => {
      const { makeService } = buildServices();
      const service = makeService();

      expect(service.getRecentSettlements()).toEqual([]);
    });
  });
});
