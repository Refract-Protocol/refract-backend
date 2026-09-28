import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Account,
  BASE_FEE,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import Redis from "ioredis";
import { AppConfig } from "../config/configuration";
import { TxService } from "./tx.service";

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

function buildConfig(overrides: Partial<AppConfig["stellar"]> = {}): ConfigService<AppConfig, true> {
  const stellar: AppConfig["stellar"] = {
    network: "testnet",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: NETWORK_PASSPHRASE,
    poolContractId: StrKey.encodeContract(Buffer.alloc(32, 1)),
    policyContractId: "",
    oracleContractId: "",
    relayerSecret: "",
    ...overrides,
  };
  return {
    get: jest.fn((key: string) => (key === "stellar" ? stellar : { url: "redis://localhost:6379" })),
  } as unknown as ConfigService<AppConfig, true>;
}

/** A validly-formed, signed (but never network-submitted) tx envelope for TxService to parse. */
function buildSignedXdr(timeout = 30): string {
  const signer = Keypair.random();
  const account = new Account(signer.publicKey(), "1");
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
    .setTimeout(timeout)
    .build();
  tx.sign(signer);
  return tx.toXDR();
}

const PENDING_SEND_RESULT = { status: "PENDING" as const, hash: "mock-tx-hash", latestLedger: 1, latestLedgerCloseTime: 1 };

describe("TxService", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.spyOn(Redis.prototype, "set").mockResolvedValue("OK");
  });

  describe("submit", () => {
    it("rejects malformed XDR without contacting the network", async () => {
      const service = new TxService(buildConfig());
      const sendSpy = jest.spyOn(rpc.Server.prototype, "sendTransaction");
      expect.assertions(2);

      try {
        await service.submit("not-valid-xdr");
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect(sendSpy).not.toHaveBeenCalled();
      }
    });

    it("rejects a stale signed XDR without reserving or submitting it", async () => {
      const service = new TxService(buildConfig());
      jest.useFakeTimers().setSystemTime(new Date(1_000));
      const staleXdr = buildSignedXdr();
      jest.useRealTimers();
      const setSpy = jest.spyOn(Redis.prototype, "set");
      const sendSpy = jest.spyOn(rpc.Server.prototype, "sendTransaction");

      const result = await service.submit(staleXdr);

      expect(result.confirmed).toBe(false);
      expect(result.error).toBe("Transaction is expired or has no expiration time");
      expect(setSpy).not.toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("recognizes an already-submitted signed XDR and never submits it twice", async () => {
      const service = new TxService(buildConfig());
      const signedXdr = buildSignedXdr();
      jest.spyOn(Redis.prototype, "set").mockResolvedValueOnce("OK").mockResolvedValueOnce(null);
      const sendSpy = jest
        .spyOn(rpc.Server.prototype, "sendTransaction")
        .mockResolvedValue({ status: "ERROR", hash: "mock-tx-hash", latestLedger: 1, latestLedgerCloseTime: 1 });

      const first = await service.submit(signedXdr);
      const second = await service.submit(signedXdr);

      expect(first.error).toContain("ERROR");
      expect(second).toEqual({
        confirmed: false,
        txHash: expect.any(String),
        error: "Transaction has already been submitted",
      });
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(Redis.prototype.set).toHaveBeenCalledWith(
        expect.stringMatching(/^stellar:submitted:/),
        expect.any(String),
        "EX",
        expect.any(Number),
        "NX"
      );
    });

    it("fails closed when the replay registry cannot be reached", async () => {
      const service = new TxService(buildConfig());
      jest.spyOn(Redis.prototype, "set").mockRejectedValue(new Error("Redis unavailable"));
      const sendSpy = jest.spyOn(rpc.Server.prototype, "sendTransaction");

      const result = await service.submit(buildSignedXdr());

      expect(result.confirmed).toBe(false);
      expect(result.error).toBe("Transaction replay protection is unavailable");
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("submits, confirms, and reports the tx hash for a successful submission", async () => {
      const service = new TxService(buildConfig());
      const signedXdr = buildSignedXdr();

      jest.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue(PENDING_SEND_RESULT);
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

      const result = await service.submit(signedXdr);

      expect(result).toEqual({ confirmed: true, txHash: "mock-tx-hash" });
    });

    it("reports an unconfirmed result when the network rejects the submission outright", async () => {
      const service = new TxService(buildConfig());
      const signedXdr = buildSignedXdr();

      jest
        .spyOn(rpc.Server.prototype, "sendTransaction")
        .mockResolvedValue({ status: "ERROR", hash: "mock-tx-hash", latestLedger: 1, latestLedgerCloseTime: 1 });
      const getTransactionSpy = jest.spyOn(rpc.Server.prototype, "getTransaction");

      const result = await service.submit(signedXdr);

      expect(result.confirmed).toBe(false);
      expect(result.error).toContain("ERROR");
      expect(getTransactionSpy).not.toHaveBeenCalled();
    });

    it("reports an unconfirmed result when the submitted transaction fails on-chain", async () => {
      const service = new TxService(buildConfig());
      const signedXdr = buildSignedXdr();

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

      const result = await service.submit(signedXdr);

      expect(result).toEqual({ confirmed: false, txHash: "mock-tx-hash", error: "Transaction failed on-chain" });
    });

    it("catches an unexpected error (e.g. a network failure) and reports confirmed:false", async () => {
      const service = new TxService(buildConfig());
      const signedXdr = buildSignedXdr();

      jest.spyOn(rpc.Server.prototype, "sendTransaction").mockRejectedValue(new Error("connection refused"));

      const result = await service.submit(signedXdr);

      expect(result.confirmed).toBe(false);
      expect(result.error).toBe("connection refused");
    });
  });
});
