import { ConfigService } from "@nestjs/config";
import { Account, Keypair, StrKey, TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { ClaimSettlementService, isArgumentArityMismatch } from "./claim-settlement.service";
import { AppConfig } from "../config/configuration";
import { ConfigService } from "@nestjs/config";
import { testStellarConfig } from "../config/test-stellar";
import { RelayerAccountService } from "../stellar/relayer-account.service";
import { StellarConfigValidator } from "../stellar/stellar-config.validator";
import { FeeStrategyService } from "../stellar/fee-strategy.service";
import { SorobanRpcService } from "../stellar/soroban-rpc.service";

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

const CONFIRMATION: AppConfig["confirmation"] = {
  initialIntervalMs: 10,
  backoffMultiplier: 1.5,
  maxIntervalMs: 50,
  deadlineMs: 200,
  jitterRatio: 0,
  settlementDeadlineMs: 200,
  httpDeadlineMs: 100,
};

function buildConfig(overrides: Partial<AppConfig["stellar"]> = {}): ConfigService<AppConfig, true> {
  const stellar: AppConfig["stellar"] = {
    network: "testnet",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: NETWORK_PASSPHRASE,
    poolContractId: StrKey.encodeContract(Buffer.alloc(32, 1)),
    relayerSecret: Keypair.random().secret(),
    rpcTimeoutMs: 10000,
    rpcMaxRetries: 3,
    restoreFeeCeiling: "5000000",
    restoreMaxAttemptsPerPolicy: 3,
    ttlExtensionLedgers: 17280,
    proactiveTtlExtendWithinDays: 30,
    ...overrides,
  };
  const fees: AppConfig["fees"] = {
    ceilingStroops: "10000000",
    statsTtlMs: 15_000,
    profiles: {
      moderate: { percentile: 90, multiplier: 1.0 },
      aggressive: { percentile: 99, multiplier: 1.0 },
    },
  };
  return {
    get: jest.fn((key: string) => {
      if (key === "stellar") return stellar;
      if (key === "fees") return fees;
      if (key === "confirmation") return CONFIRMATION;
      return undefined;
    }),
  } as unknown as ConfigService<AppConfig, true>;
}

function createService(overrides: Partial<AppConfig["stellar"]> = {}): ClaimSettlementService {
  const config = buildConfig(overrides);
  const rpcSvc = new SorobanRpcService(config);
  return new ClaimSettlementService(config, rpcSvc);
}

function buildSettlementService(overrides: Partial<AppConfig["stellar"]> = {}) {
  const config = buildConfig(overrides);
  const rpcService = new SorobanRpcService(config);
  const feeStrategy = new FeeStrategyService(rpcService, config);
  jest.spyOn(feeStrategy, "estimateInclusionFee").mockResolvedValue(BASE_FEE);
  jest.spyOn(feeStrategy, "assertTotalUnderCeiling").mockImplementation(() => undefined);
  return new ClaimSettlementService(config, rpcService, feeStrategy);
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

function successTx(): rpc.Api.GetTransactionResponse {
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
  };
}

/** Captures the invokeHostFunction args from prepareTransaction's input. */
function captureCallArgs(prepareSpy: jest.SpyInstance): xdr.ScVal[] {
  const builtTx = prepareSpy.mock.calls[0][0] as { toXDR: () => string };
  const tx = TransactionBuilder.fromXDR(builtTx.toXDR(), NETWORK_PASSPHRASE);
  const op = tx.operations[0] as { func: xdr.HostFunction };
  const invocation = op.func.invokeContract();
  return [...invocation.args()];
}

describe("isArgumentArityMismatch", () => {
  it("flags arity/type errors as permanent", () => {
    expect(isArgumentArityMismatch("Error(WasmVm, InvalidInput): unexpected type")).toBe(true);
    expect(isArgumentArityMismatch("HostError: Error(Contract, #1) Wrong argument arity")).toBe(true);
  });

  it("does not flag timeouts or transport failures", () => {
    expect(isArgumentArityMismatch("prepareTransaction timed out")).toBe(false);
    expect(isArgumentArityMismatch("connect ECONNREFUSED")).toBe(false);
    expect(isArgumentArityMismatch("503 Service Unavailable")).toBe(false);
  });
});

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
      const service = buildSettlementService({ poolContractId: "" });
      expect(service.isConfigured()).toBe(false);
    });

    it("is false when the relayer secret is missing", () => {
      const service = buildSettlementService({ relayerSecret: "" });
      expect(service.isConfigured()).toBe(false);
    });

    it("is true once both the pool contract ID and relayer secret are set", () => {
      const service = buildSettlementService();
      expect(service.isConfigured()).toBe(true);
    });
  });

  describe("settleClaim", () => {
    it("returns settled:false without touching the network when unconfigured", async () => {
      const service = buildSettlementService({ poolContractId: "" });
      const getAccountSpy = jest.spyOn(rpc.Server.prototype, "getAccount");
      const relayer = mockRelayer(true);

      const result = await service.settleClaim(1n, { holder: Keypair.random().publicKey(), payout: 100n });

      expect(result.settled).toBe(false);
      const relayer = mockRelayer(true);
      const service = new ClaimSettlementService(buildConfig({ poolContractId: "" }), relayer, mockValidator(false));

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

      const result = await service.settleClaim(42n, { holder, payout: 5_000_000_000n });

      jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(Keypair.random().publicKey(), "1"));
      jest.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) => tx as never);
      jest
        .spyOn(rpc.Server.prototype, "sendTransaction")
        .mockResolvedValue({ status: "ERROR", hash: "mock-tx-h
      const holder = Keypair.random().publicKey();

      const result = await service.settleClaim(42n, { holder, payout: 5_000_000_000n });

      jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(Keypair.random().publicKey(), "1"));
      jest.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) => tx as never);
      jest
        .spyOn(rpc.Server.prototype, "sendTransaction")
        .mockResolvedValue({ status: "ERROR", hash: "mock-tx-hash", latestLedger: 1, latestLedgerCloseTime: 1 });
      const getTransactionSpy = jest.spyOn(rpc.Server.prototype, "getTransaction");

      const result = await service.settleClaim(1n, { payout: 100n });

      expect(result.settled).toBe(false);
      expect(result.error).toMatch(/rejected|ERROR|UNKNOWN/i);
      expect(getTransactionSpy).not.toHaveBeenCalled();
    });

    it("does not settle when the submitted transaction fails on-chain", async () => {
      const service = createService();
      const holder = Keypair.random().publicKey();

      const result = await service.settleClaim(1n, { payout: 100n });

      jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(Keypair.random().publicKey(), "1"));
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

      const result = await service.settleCla
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

      const result = await service.settleClaim(1n, { payout: 100n });

      expect(result).toMatchObject({
        settled: false,
        txHash: "mock-tx-hash",
        error: "Transaction failed on-chain",
        permanent: true,
      });
    });

    it("gives up and reports a timeout once confirmation polling is exhausted", async () => {
      jest.useFakeTimers();
      const relayer = mockRelayer(true);
      (relayer.submitRelayerTransaction as jest.Mock).mockResolvedValue({ hash: "mock-tx-hash" });
      const service = new ClaimSettlementService(buildConfig(), relayer, mockValidator(true));
      const holder = Keypair.random().publicKey();

      jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(Keypair.random().publicKey(), "1"));
      jest.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) => tx as never);
      jest.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue(PENDING_SEND_RESULT);

      jest.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
        latestLedger: 1,
        latestLedgerCloseTime: 1,
        oldestLedger: 1,
        oldestLedgerCloseTime: 1,
      });

      const resultPromise = service.settleClaim(1n, holder, 100n);
      await jest.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.settled).toBe(false);
      expect(result.error).toContain("Timed out
      jest.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
        latestLedger: 1,
        latestLedgerCloseTime: 1,
        oldestLedger: 1,
        oldestLedgerCloseTime: 1,
      });

      const resultPromise = service.settleClaim(1n, holder, 100n);
      await jest.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.settled).toBe(false);
      expect(result.error).toContain("Timed out");
      expect(result.permanent).toBeFalsy();
    });

    it("classifies prepareTransaction arity/type errors as permanent", async () => {
      const service = new ClaimSettlementService(buildConfig());

      jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(Keypair.random().publicKey(), "1"));
      jest
        .spyOn(rpc.Server.prototype, "prepareTransaction")
        .mockRejectedValue(new Error("HostError: Unexpected type / wrong arity for process_claim"));

      const result = await service.settleClaim(1n);

      expect(result.settled).toBe(false);
      expect(result.permanent).toBe(true);
      expect(result.error).toMatch(/arity|type/i);
    });

    it("does not classify a prepareTransaction timeout as a signature mismatch", async () => {
      const service = new ClaimSettlementService(buildConfig());

      jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(Keypair.random().publicKey(), "1"));
      jest.spyOn(rpc.Server.prototype, "prepareTransaction").mockRejectedValue(new Error("prepareTransaction timed out"));

      const result = await service.settleClaim(1n);

      expect(result.settled).toBe(false);
      expect(result.permanent).toBeUndefined();
    });

    it("catches an unexpected error (e.g. a network failure) and reports settled:false", async () => {
      const service = buildSettlementService();
      const holder = Keypair.random().publicKey();

      jest.spyOn(rpc.Server.prototype, "getAccount").mockRejectedValue(new Error("connection refused"));

      const result = await service.settleClaim(1n, holder, 100n);

      expect(result.settled).toBe(false);
      expect(result.error).toBe("connection refused");
    });
  });
});


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
