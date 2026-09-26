import { ConfigService } from "@nestjs/config";
import { Account, Keypair, StrKey, TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { ClaimSettlementService, isArgumentArityMismatch } from "./claim-settlement.service";
import { AppConfig } from "../config/configuration";

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
    policyContractId: "",
    oracleContractId: "",
    relayerSecret: Keypair.random().secret(),
    ...overrides,
  };
  return {
    get: jest.fn((key: string) => {
      if (key === "stellar") return stellar;
      if (key === "confirmation") return CONFIRMATION;
      return undefined;
    }),
  } as unknown as ConfigService<AppConfig, true>;
}

const PENDING_SEND_RESULT = { status: "PENDING" as const, hash: "mock-tx-hash", latestLedger: 1, latestLedgerCloseTime: 1 };

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

describe("ClaimSettlementService", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe("isConfigured", () => {
    it("is false when the pool contract ID is missing", () => {
      const service = new ClaimSettlementService(buildConfig({ poolContractId: "" }));
      expect(service.isConfigured()).toBe(false);
    });

    it("is false when the relayer secret is missing", () => {
      const service = new ClaimSettlementService(buildConfig({ relayerSecret: "" }));
      expect(service.isConfigured()).toBe(false);
    });

    it("is true once both the pool contract ID and relayer secret are set", () => {
      const service = new ClaimSettlementService(buildConfig());
      expect(service.isConfigured()).toBe(true);
    });
  });

  describe("settleClaim", () => {
    it("returns settled:false without touching the network when unconfigured", async () => {
      const service = new ClaimSettlementService(buildConfig({ poolContractId: "" }));
      const getAccountSpy = jest.spyOn(rpc.Server.prototype, "getAccount");

      const result = await service.settleClaim(1n, { holder: Keypair.random().publicKey(), payout: 100n });

      expect(result.settled).toBe(false);
      expect(result.permanent).toBe(true);
      expect(result.error).toContain("not configured");
      expect(getAccountSpy).not.toHaveBeenCalled();
    });

    it("passes exactly one scvU64 argument to process_claim, including ids above 2^53", async () => {
      const service = new ClaimSettlementService(buildConfig());
      const hugeId = 9_007_199_254_740_993n; // Number.MAX_SAFE_INTEGER + 2

      jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(Keypair.random().publicKey(), "1"));
      const prepareSpy = jest
        .spyOn(rpc.Server.prototype, "prepareTransaction")
        .mockImplementation(async (tx) => tx as never);
      jest.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue(PENDING_SEND_RESULT);
      jest.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(successTx());

      await service.settleClaim(hugeId, { holder: "GHOLDER", payout: 5_000_000_000n });

      const args = captureCallArgs(prepareSpy);
      expect(args).toHaveLength(1);
      expect(args[0].switch()).toBe(xdr.ScValType.scvU64());
      expect(scValToNative(args[0])).toBe(hugeId);
      // Sanity: explicit encoding matches nativeToScVal with { type: "u64" }
      expect(args[0].toXDR("base64")).toBe(nativeToScVal(hugeId, { type: "u64" }).toXDR("base64"));
    });

    it("builds, signs, submits, and confirms a successful settlement", async () => {
      const service = new ClaimSettlementService(buildConfig());

      jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(Keypair.random().publicKey(), "1"));
      jest.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) => tx as never);
      jest.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue(PENDING_SEND_RESULT);
      jest.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue(successTx());

      const result = await service.settleClaim(42n, { holder: Keypair.random().publicKey(), payout: 5_000_000_000n });

      expect(result).toEqual({ settled: true, txHash: "mock-tx-hash" });
    });

    it("does not settle when the submission is rejected outright", async () => {
      const service = new ClaimSettlementService(buildConfig());

      jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(Keypair.random().publicKey(), "1"));
      jest.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) => tx as never);
      jest
        .spyOn(rpc.Server.prototype, "sendTransaction")
        .mockResolvedValue({ status: "ERROR", hash: "mock-tx-hash", latestLedger: 1, latestLedgerCloseTime: 1 });
      const getTransactionSpy = jest.spyOn(rpc.Server.prototype, "getTransaction");

      const result = await service.settleClaim(1n, { payout: 100n });

      expect(result.settled).toBe(false);
      expect(result.error).toContain("ERROR");
      expect(getTransactionSpy).not.toHaveBeenCalled();
    });

    it("does not settle when the submitted transaction fails on-chain", async () => {
      const service = new ClaimSettlementService(buildConfig());

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

      const result = await service.settleClaim(1n, { payout: 100n });

      expect(result).toMatchObject({
        settled: false,
        txHash: "mock-tx-hash",
        error: "Transaction failed on-chain",
        permanent: true,
      });
    });

    it("gives up and reports a timeout once confirmation polling hits the deadline", async () => {
      const service = new ClaimSettlementService(buildConfig());

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

      const result = await service.settleClaim(1n, { payout: 100n });

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
      const service = new ClaimSettlementService(buildConfig());

      jest.spyOn(rpc.Server.prototype, "getAccount").mockRejectedValue(new Error("connection refused"));

      const result = await service.settleClaim(1n, { payout: 100n });

      expect(result.settled).toBe(false);
      expect(result.error).toBe("connection refused");
    });
  });
});
