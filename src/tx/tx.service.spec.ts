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
  return { get: jest.fn().mockReturnValue(stellar) } as unknown as ConfigService<AppConfig, true>;
}

/** A validly-formed, signed (but never network-submitted) tx envelope for TxService to parse. */
function buildSignedXdr(): string {
  const signer = Keypair.random();
  const account = new Account(signer.publicKey(), "1");
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
    .setTimeout(30)
    .build();
  tx.sign(signer);
  return tx.toXDR();
}

const PENDING_SEND_RESULT = { status: "PENDING" as const, hash: "mock-tx-hash", latestLedger: 1, latestLedgerCloseTime: 1 };

describe("TxService", () => {
  afterEach(() => {
    jest.restoreAllMocks();
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
