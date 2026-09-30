import { ConfigService } from "@nestjs/config";
import {
  Account,
  BASE_FEE,
  Keypair,
  Operation,
  rpc,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { SorobanRpcService } from "./soroban-rpc.service";
import {
  SorobanContractError,
  SorobanRateLimitError,
  SorobanRestoreFeeExceededError,
  SorobanTransientError,
} from "./soroban-errors";

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

function buildConfig(overrides: Partial<AppConfig["stellar"]> = {}): ConfigService<AppConfig, true> {
  const stellar: AppConfig["stellar"] = {
    network: "testnet",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: NETWORK_PASSPHRASE,
    poolContractId: "",
    policyContractId: "",
    oracleContractId: "",
    relayerSecret: "",
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

function minimalTx(source: string): Transaction {
  const account = new Account(source, "1");
  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
    .setTimeout(30)
    .build();
}

function minimalSorobanData(): xdr.SorobanTransactionData {
  return new xdr.SorobanTransactionData({
    resources: new xdr.SorobanResources({
      footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
      instructions: 0,
      readBytes: 0,
      writeBytes: 0,
    }),
    resourceFee: xdr.Int64.fromString("0"),
    ext: new xdr.ExtensionPoint(),
  });
}

function restoreSim(minFee: string): rpc.Api.SimulateTransactionResponse {
  const transactionData = { build: () => minimalSorobanData() };
  return {
    _parsed: true,
    id: "test",
    latestLedger: 1,
    events: [],
    transactionData: transactionData as never,
    minResourceFee: minFee,
    cost: { cpuInsns: "0", memBytes: "0" },
    result: { retval: {} as never, auth: [] },
    restorePreamble: {
      minResourceFee: minFee,
      transactionData,
    },
  } as unknown as rpc.Api.SimulateTransactionResponse;
}

function successSim(): rpc.Api.SimulateTransactionResponse {
  return {
    _parsed: true,
    id: "test",
    latestLedger: 1,
    events: [],
    transactionData: {} as never,
    minResourceFee: "0",
    cost: { cpuInsns: "0", memBytes: "0" },
    result: { retval: {} as never, auth: [] },
  } as unknown as rpc.Api.SimulateTransactionResponse;
}

describe("SorobanRpcService", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe("withRetry", () => {
    it("retries transient failures then succeeds", async () => {
      const svc = new SorobanRpcService(buildConfig({ rpcMaxRetries: 3 }));
      let calls = 0;
      jest.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(async () => {
        calls++;
        if (calls < 3) throw new Error("ECONNRESET");
        return new Account(Keypair.random().publicKey(), "1");
      });

      await svc.getAccount("GTEST");
      expect(calls).toBe(3);
    });

    it("does not retry contract / simulation errors", async () => {
      const svc = new SorobanRpcService(buildConfig({ rpcMaxRetries: 3 }));
      const simSpy = jest.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue({
        _parsed: true,
        id: "test",
        latestLedger: 1,
        events: [],
        error: "simulation failed: host unreachable",
      } as rpc.Api.SimulateTransactionResponse);

      const tx = minimalTx(Keypair.random().publicKey());
      await expect(svc.simulateTransaction(tx)).rejects.toBeInstanceOf(SorobanContractError);
      expect(simSpy).toHaveBeenCalledTimes(1);
    });

    it("honors Retry-After on 429 rate limits", async () => {
      jest.useFakeTimers();
      const svc = new SorobanRpcService(buildConfig({ rpcMaxRetries: 2 }));
      let calls = 0;
      jest.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(async () => {
        calls++;
        if (calls === 1) {
          const err = new Error("Too Many Requests") as Error & {
            status: number;
            response: { headers: Record<string, string> };
          };
          err.status = 429;
          err.response = { headers: { "retry-after": "2" } };
          throw err;
        }
        return new Account(Keypair.random().publicKey(), "1");
      });

      const promise = svc.getAccount("GTEST");
      await jest.advanceTimersByTimeAsync(2000);
      await promise;
      expect(calls).toBe(2);
    });

    it("surfaces RPC timeout as SorobanTransientError", async () => {
      jest.useFakeTimers();
      const svc = new SorobanRpcService(buildConfig({ rpcTimeoutMs: 5000, rpcMaxRetries: 0 }));
      jest.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(() => new Promise(() => {}));

      const promise = svc.getAccount("GTEST");
      const expectation = expect(promise).rejects.toBeInstanceOf(SorobanTransientError);
      await jest.advanceTimersByTimeAsync(5000);
      await expectation;
    });

    it("grows backoff between transient retries", async () => {
      jest.useFakeTimers();
      jest.spyOn(Math, "random").mockReturnValue(0);
      const svc = new SorobanRpcService(buildConfig({ rpcMaxRetries: 2 }));
      let calls = 0;
      jest.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(async () => {
        calls++;
        if (calls <= 2) throw new Error("fetch failed");
        return new Account(Keypair.random().publicKey(), "1");
      });

      const promise = svc.getAccount("GTEST");
      await jest.advanceTimersByTimeAsync(1000);
      await jest.advanceTimersByTimeAsync(2000);
      await promise;
      expect(calls).toBe(3);
    });
  });

  describe("classifyError", () => {
    it("maps 429 to SorobanRateLimitError", () => {
      const svc = new SorobanRpcService(buildConfig());
      const err = svc.classifyError(Object.assign(new Error("rate limit"), { status: 429 }));
      expect(err).toBeInstanceOf(SorobanRateLimitError);
    });
  });

  describe("restore preamble", () => {
    it("auto-restores then retries prepareTransaction", async () => {
      jest.useFakeTimers();
      const relayer = Keypair.random();
      const svc = new SorobanRpcService(buildConfig({ rpcMaxRetries: 0 }));
      const tx = minimalTx(relayer.publicKey());

      jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(relayer.publicKey(), "1"));
      jest
        .spyOn(rpc.Server.prototype, "simulateTransaction")
        .mockResolvedValueOnce(restoreSim("1000"))
        .mockResolvedValue(successSim());
      jest
        .spyOn(rpc.Server.prototype, "prepareTransaction")
        .mockRejectedValueOnce(new Error("needs restore"))
        .mockImplementation(async (t) => t as Transaction);
      const submitRestoreSpy = jest
        .spyOn(SorobanRpcService.prototype as unknown as { submitRestore: () => Promise<void> }, "submitRestore")
        .mockResolvedValue(undefined);

      await svc.prepareTransaction(tx, {
        autoRestore: true,
        policyId: "policy-restore",
        relayerKeypair: relayer,
      });

      expect(submitRestoreSpy).toHaveBeenCalledTimes(1);
    });

    it("rejects restore when estimated fee exceeds ceiling", async () => {
      const svc = new SorobanRpcService(buildConfig({ restoreFeeCeiling: "1000", rpcMaxRetries: 0 }));
      const tx = minimalTx(Keypair.random().publicKey());
      jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(Keypair.random().publicKey(), "1"));
      jest.spyOn(rpc.Server.prototype, "prepareTransaction").mockRejectedValue(new Error("restore needed"));
      jest.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue(restoreSim("5000000"));

      await expect(
        svc.prepareTransaction(tx, { autoRestore: true, relayerKeypair: Keypair.random(), policyId: "p1" })
      ).rejects.toBeInstanceOf(SorobanRestoreFeeExceededError);
    });

    it("stops after restoreMaxAttemptsPerPolicy", async () => {
      const svc = new SorobanRpcService(buildConfig({ restoreMaxAttemptsPerPolicy: 2, rpcMaxRetries: 0 }));
      const relayer = Keypair.random();
      const tx = minimalTx(relayer.publicKey());
      const internal = svc as unknown as { restoreAttempts: Map<string, number> };
      internal.restoreAttempts.set("cap-policy", 2);

      jest.spyOn(rpc.Server.prototype, "prepareTransaction").mockRejectedValue(new Error("restore needed"));
      jest.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue(restoreSim("1000"));

      await expect(
        svc.prepareTransaction(tx, { autoRestore: true, relayerKeypair: relayer, policyId: "cap-policy" })
      ).rejects.toThrow(/cap/);
      expect(svc.getRestoreAttemptCount("cap-policy")).toBe(2);
    });
  });
});
