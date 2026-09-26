import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Account,
  BASE_FEE,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { PolicyService } from "../policy/policy.service";
import { TxService } from "./tx.service";

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

const CONFIRMATION: AppConfig["confirmation"] = {
  initialIntervalMs: 10,
  backoffMultiplier: 1.5,
  maxIntervalMs: 50,
  deadlineMs: 200,
  jitterRatio: 0,
  settlementDeadlineMs: 200,
  httpDeadlineMs: 200,
};

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
    get: jest.fn((key: string) => {
      if (key === "stellar") return stellar;
      if (key === "confirmation") return CONFIRMATION;
      return undefined;
    }),
  } as unknown as ConfigService<AppConfig, true>;
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

function mockPolicyService(): jest.Mocked<PolicyService> {
  return {
    activateFromBuyConfirmation: jest.fn().mockReturnValue(null),
  } as unknown as jest.Mocked<PolicyService>;
}

const PENDING_SEND_RESULT = { status: "PENDING" as const, hash: "mock-tx-hash", latestLedger: 1, latestLedgerCloseTime: 1 };

describe("TxService", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("submit", () => {
    it("rejects malformed XDR without contacting the network", async () => {
      const service = new TxService(buildConfig(), mockPolicyService());
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
      const policyService = mockPolicyService();
      const service = new TxService(buildConfig(), policyService);
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
        returnValue: nativeToScVal(42n, { type: "u64" }),
      });

      const result = await service.submit(signedXdr);

      expect(result).toMatchObject({ confirmed: true, outcome: "success", txHash: "mock-tx-hash" });
      expect(policyService.activateFromBuyConfirmation).toHaveBeenCalledWith(
        "mock-tx-hash",
        expect.anything()
      );
    });

    it("surfaces onChainPolicyId when the confirmation activates a pending policy", async () => {
      const policyService = mockPolicyService();
      policyService.activateFromBuyConfirmation.mockReturnValue({
        onChainPolicyId: "9007199254740993",
      } as never);
      const service = new TxService(buildConfig(), policyService);
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
        returnValue: nativeToScVal(9007199254740993n, { type: "u64" }),
      });

      const result = await service.submit(signedXdr);

      expect(result.onChainPolicyId).toBe("9007199254740993");
    });

    it("reports an unconfirmed result when the network rejects the submission outright", async () => {
      const service = new TxService(buildConfig(), mockPolicyService());
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

    it("reports failed_on_chain when the submitted transaction fails on-chain", async () => {
      const service = new TxService(buildConfig(), mockPolicyService());
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

      expect(result).toMatchObject({
        confirmed: false,
        outcome: "failed_on_chain",
        txHash: "mock-tx-hash",
        error: "Transaction failed on-chain",
      });
    });

    it("catches an unexpected error (e.g. a network failure) and reports confirmed:false", async () => {
      const service = new TxService(buildConfig(), mockPolicyService());
      const signedXdr = buildSignedXdr();

      jest.spyOn(rpc.Server.prototype, "sendTransaction").mockRejectedValue(new Error("connection refused"));

      const result = await service.submit(signedXdr);

      expect(result.confirmed).toBe(false);
      expect(result.error).toBe("connection refused");
    });
  });
});
