import { ConfigService } from "@nestjs/config";
import { Account, Keypair, StrKey, rpc } from "@stellar/stellar-sdk";
import { ClaimSettlementService } from "./claim-settlement.service";
import { AppConfig } from "../config/configuration";
import { testStellarConfig } from "../config/test-stellar";
import { RelayerAccountService } from "../stellar/relayer-account.service";
import { StellarConfigValidator } from "../stellar/stellar-config.validator";

function buildConfig(overrides: Partial<AppConfig["stellar"]> = {}): ConfigService<AppConfig, true> {
  const stellar = testStellarConfig({
    poolContractId: StrKey.encodeContract(Buffer.alloc(32, 1)),
    relayerSecret: Keypair.random().secret(),
    ...overrides,
  });
  return { get: jest.fn().mockReturnValue(stellar) } as unknown as ConfigService<AppConfig, true>;
}

function mockRelayer(ready = true): RelayerAccountService {
  return {
    isReady: jest.fn().mockReturnValue(ready),
    isConfigured: jest.fn().mockReturnValue(ready),
    submitRelayerTransaction: jest.fn().mockImplementation(async (buildFn) => {
      const account = new Account(Keypair.random().publicKey(), "1");
      const tx = await buildFn(account, "100");
      // Callers expect a hash; short-circuit prepare/sign/send.
      void tx;
      return { hash: "mock-tx-hash" };
    }),
    getHealthStatus: jest.fn().mockReturnValue({
      configured: ready,
      balanceReady: ready,
      publicKey: ready ? Keypair.random().publicKey() : null,
      balance: ready ? "1000000000" : null,
      sequence: ready ? "1" : null,
    }),
  } as unknown as RelayerAccountService;
}

function mockValidator(fullyConfigured: boolean): StellarConfigValidator {
  return {
    isNetworkFullyConfigured: jest.fn().mockReturnValue(fullyConfigured),
    getHealthStatus: jest.fn().mockReturnValue({ fullyConfigured }),
  } as unknown as StellarConfigValidator;
}

describe("ClaimSettlementService", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe("isConfigured", () => {
    it("is false when the network is not fully configured", () => {
      const service = new ClaimSettlementService(buildConfig({ poolContractId: "" }), mockRelayer(true), mockValidator(false));
      expect(service.isConfigured()).toBe(false);
    });

    it("is false when the relayer is not ready", () => {
      const service = new ClaimSettlementService(buildConfig(), mockRelayer(false), mockValidator(true));
      expect(service.isConfigured()).toBe(false);
    });

    it("is true once the network is configured and the relayer is ready", () => {
      const service = new ClaimSettlementService(buildConfig(), mockRelayer(true), mockValidator(true));
      expect(service.isConfigured()).toBe(true);
    });
  });

  describe("settleClaim", () => {
    it("returns settled:false without touching the network when unconfigured", async () => {
      const relayer = mockRelayer(true);
      const service = new ClaimSettlementService(buildConfig({ poolContractId: "" }), relayer, mockValidator(false));

      const result = await service.settleClaim("policy-1", Keypair.random().publicKey(), 100n);

      expect(result.settled).toBe(false);
      expect(result.error).toContain("not fully configured");
      expect(relayer.submitRelayerTransaction).not.toHaveBeenCalled();
    });

    it("builds, signs, submits, and confirms a successful settlement via RelayerAccountService", async () => {
      const relayer = mockRelayer(true);
      const service = new ClaimSettlementService(buildConfig(), relayer, mockValidator(true));
      const holder = Keypair.random().publicKey();

      jest.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) => tx as never);
      jest.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        latestLedger: 2,
        latestLedgerCloseTime: 2,
        oldestLedger: 1,
        oldestLedgerCloseTime: 1,
        ledger: 2,
        createdAt: 2,
        applicationOrder: 1,
        feeBump: false,
        envelopeXdr: {} as never,
        resultXdr: {} as never,
        resultMetaXdr: {} as never,
      });

      // Relayer mock returns hash immediately; still poll confirmation.
      (relayer.submitRelayerTransaction as jest.Mock).mockResolvedValue({ hash: "mock-tx-hash" });

      const result = await service.settleClaim("policy-1", holder, 5_000_000_000n);

      expect(result).toEqual({ settled: true, txHash: "mock-tx-hash" });
      expect(relayer.submitRelayerTransaction).toHaveBeenCalled();
    });

    it("does not settle when confirmation reports on-chain failure", async () => {
      const relayer = mockRelayer(true);
      (relayer.submitRelayerTransaction as jest.Mock).mockResolvedValue({ hash: "mock-tx-hash" });
      const service = new ClaimSettlementService(buildConfig(), relayer, mockValidator(true));
      const holder = Keypair.random().publicKey();

      jest.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.FAILED,
        latestLedger: 2,
        latestLedgerCloseTime: 2,
        oldestLedger: 1,
        oldestLedgerCloseTime: 1,
        ledger: 2,
        createdAt: 2,
        applicationOrder: 1,
        feeBump: false,
        envelopeXdr: {} as never,
        resultXdr: {} as never,
        resultMetaXdr: {} as never,
      });

      const result = await service.settleClaim("policy-1", holder, 100n);

      expect(result).toEqual({ settled: false, txHash: "mock-tx-hash", error: "Transaction failed on-chain" });
    });

    it("gives up and reports a timeout once confirmation polling is exhausted", async () => {
      jest.useFakeTimers();
      const relayer = mockRelayer(true);
      (relayer.submitRelayerTransaction as jest.Mock).mockResolvedValue({ hash: "mock-tx-hash" });
      const service = new ClaimSettlementService(buildConfig(), relayer, mockValidator(true));
      const holder = Keypair.random().publicKey();

      jest.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
        latestLedger: 1,
        latestLedgerCloseTime: 1,
        oldestLedger: 1,
        oldestLedgerCloseTime: 1,
      });

      const resultPromise = service.settleClaim("policy-1", holder, 100n);
      await jest.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toEqual({ settled: false, txHash: "mock-tx-hash", error: "Timed out waiting for confirmation" });
    });

    it("catches an unexpected error from the relayer and reports settled:false", async () => {
      const relayer = mockRelayer(true);
      (relayer.submitRelayerTransaction as jest.Mock).mockRejectedValue(new Error("connection refused"));
      const service = new ClaimSettlementService(buildConfig(), relayer, mockValidator(true));
      const holder = Keypair.random().publicKey();

      const result = await service.settleClaim("policy-1", holder, 100n);

      expect(result.settled).toBe(false);
      expect(result.error).toBe("connection refused");
    });
  });
});
