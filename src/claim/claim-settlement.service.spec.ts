import { ConfigService } from "@nestjs/config";
import { Account, Keypair, StrKey, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { ClaimSettlementService, decodePoolErrorMessage } from "./claim-settlement.service";
import { AppConfig } from "../config/configuration";
import { SorobanRpcService } from "../stellar/soroban-rpc.service";

function buildConfig(overrides: Partial<AppConfig["stellar"]> = {}): ConfigService<AppConfig, true> {
  const stellar: AppConfig["stellar"] = {
    network: "testnet",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    poolContractId: StrKey.encodeContract(Buffer.alloc(32, 1)),
    policyContractId: "",
    oracleContractId: "",
    relayerSecret: Keypair.random().secret(),
    rpcTimeoutMs: 10000,
    rpcMaxRetries: 3,
    restoreFeeCeiling: "5000000",
    restoreMaxAttemptsPerPolicy: 3,
    ttlExtensionLedgers: 17280,
    proactiveTtlExtendWithinDays: 30,
    ...overrides,
  };
  return {
    get: jest.fn((key: string) => (key === "stellar" ? stellar : undefined)),
  } as unknown as ConfigService<AppConfig, true>;
}

function createService(overrides: Partial<AppConfig["stellar"]> = {}): ClaimSettlementService {
  const config = buildConfig(overrides);
  const rpcSvc = new SorobanRpcService(config);
  return new ClaimSettlementService(config, rpcSvc);
}

const PENDING_SEND_RESULT = { status: "PENDING" as const, hash: "mock-tx-hash", latestLedger: 1, latestLedgerCloseTime: 1 };

function successTxResponse(returnValue?: ReturnType<typeof nativeToScVal>) {
  return {
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
    ...(returnValue !== undefined ? { returnValue } : {}),
  };
}

describe("ClaimSettlementService", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe("isConfigured", () => {
    it("is false when the pool contract ID is missing", () => {
      const service = createService({ poolContractId: "" });
      expect(service.isConfigured()).toBe(false);
    });

    it("is false when the relayer secret is missing", () => {
      const service = createService({ relayerSecret: "" });
      expect(service.isConfigured()).toBe(false);
    });

    it("is true once both the pool contract ID and relayer secret are set", () => {
      const service = createService();
      expect(service.isConfigured()).toBe(true);
    });
  });

  describe("settleClaim", () => {
    it("returns settled:false without touching the network when unconfigured", async () => {
      const service = createService({ poolContractId: "" });
      const getAccountSpy = jest.spyOn(rpc.Server.prototype, "getAccount");

      const result = await service.settleClaim("policy-1", Keypair.random().publicKey(), 100n);

      expect(result.settled).toBe(false);
      expect(result.error).toContain("not configured");
      expect(getAccountSpy).not.toHaveBeenCalled();
    });

    it("builds, signs, submits, and confirms a successful settlement", async () => {
      const service = createService();
      const holder = Keypair.random().publicKey();
      const payout = 5_000_000_000n;

      jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(holder, "1"));
      jest.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) => tx as never);
      jest.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue(PENDING_SEND_RESULT);
      jest.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(
        successTxResponse(nativeToScVal(payout, { type: "i128" }))
      );

      const result = await service.settleClaim("policy-1", holder, payout);

      expect(result).toEqual({ settled: true, txHash: "mock-tx-hash", actualPayout: payout });
    });

    it("decodes large i128 actualPayout values", async () => {
      const service = createService();
      const holder = Keypair.random().publicKey();
      const payout = 9_007_199_254_740_993n;

      jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(holder, "1"));
      jest.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) => tx as never);
      jest.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue(PENDING_SEND_RESULT);
      jest.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(
        successTxResponse(nativeToScVal(payout, { type: "i128" }))
      );

      const result = await service.settleClaim("policy-1", holder, payout);

      expect(result.settled).toBe(true);
      expect(result.actualPayout).toBe(payout);
    });

    it("settles with null actualPayout when returnValue is omitted", async () => {
      const service = createService();
      const holder = Keypair.random().publicKey();

      jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(holder, "1"));
      jest.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) => tx as never);
      jest.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue(PENDING_SEND_RESULT);
      jest.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(successTxResponse());

      const result = await service.settleClaim("policy-1", holder, 100n);

      expect(result).toEqual({ settled: true, txHash: "mock-tx-hash", actualPayout: null });
    });

    it("maps PoolError-style return values to actionable errors", async () => {
      const service = createService();
      const holder = Keypair.random().publicKey();
      const errReturn = xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("error"),
          val: xdr.ScVal.scvU32(6),
        }),
      ]);

      jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(holder, "1"));
      jest.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) => tx as never);
      jest.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue(PENDING_SEND_RESULT);
      jest.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(successTxResponse(errReturn));

      const result = await service.settleClaim("policy-1", holder, 100n);

      expect(result.settled).toBe(false);
      expect(result.error).toContain("PolicyNotFound");
    });

    it("does not settle when the submission is rejected outright", async () => {
      const service = createService();
      const holder = Keypair.random().publicKey();

      jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(holder, "1"));
      jest.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) => tx as never);
      jest
        .spyOn(rpc.Server.prototype, "sendTransaction")
        .mockResolvedValue({ status: "ERROR", hash: "mock-tx-hash", latestLedger: 1, latestLedgerCloseTime: 1 });
      const getTransactionSpy = jest.spyOn(rpc.Server.prototype, "getTransaction");

      const result = await service.settleClaim("policy-1", holder, 100n);

      expect(result.settled).toBe(false);
      expect(result.error).toContain("ERROR");
      expect(getTransactionSpy).not.toHaveBeenCalled();
    });

    it("does not settle when the submitted transaction fails on-chain", async () => {
      const service = createService();
      const holder = Keypair.random().publicKey();

      jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(holder, "1"));
      jest.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) => tx as never);
      jest.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue(PENDING_SEND_RESULT);
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
      const service = createService();
      const holder = Keypair.random().publicKey();

      jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(holder, "1"));
      jest.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) => tx as never);
      jest.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue(PENDING_SEND_RESULT);
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

    it("catches an unexpected error (e.g. a network failure) and reports settled:false", async () => {
      const service = createService({ rpcMaxRetries: 0 });
      const holder = Keypair.random().publicKey();

      jest.spyOn(rpc.Server.prototype, "getAccount").mockRejectedValue(new Error("connection refused"));

      const result = await service.settleClaim("policy-1", holder, 100n);

      expect(result.settled).toBe(false);
      expect(result.error).toBe("connection refused");
    });
  });

  describe("decodePoolErrorMessage", () => {
    it("maps numeric PoolError codes", () => {
      expect(decodePoolErrorMessage("error code: 6")).toContain("PolicyNotFound");
    });
  });
});
