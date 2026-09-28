import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { TxService } from "./tx.service";
import { PolicyService } from "../policy/policy.service";
import { BuyPolicyDto } from "../policy/dto/buy-policy.dto";

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

function buildConfig(overrides: Partial<AppConfig["stellar"]> = {}): ConfigService<AppConfig, true> {
  const stellar: AppConfig["stellar"] = {
    network: "testnet",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    sorobanRpcUrls: ["https://soroban-testnet.stellar.org"],
    eventStartLedger: 1,
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

function buildSignedBuyXdr(): string {
  const signer = Keypair.random();
  const account = new Account(signer.publicKey(), "1");
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(
      new Contract(StrKey.encodeContract(Buffer.alloc(32, 1))).call(
        "buy_policy",
        new Address(signer.publicKey()).toScVal(),
        xdr.ScVal.scvVoid()
      )
    )
    .setTimeout(30)
    .build();
  tx.sign(signer);
  return tx.toXDR();
}

function buildService(policyService: Pick<PolicyService, "confirmPurchase"> = { confirmPurchase: jest.fn() }): TxService {
  return new TxService(buildConfig(), policyService as unknown as PolicyService);
}

const PENDING_SEND_RESULT = { status: "PENDING" as const, hash: "mock-tx-hash", latestLedger: 1, latestLedgerCloseTime: 1 };

describe("TxService", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("submit", () => {
    it("rejects malformed XDR without contacting the network", async () => {
      const service = buildService();
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
      const service = buildService();
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
      const service = buildService();
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
      const service = buildService();
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
      const service = buildService();
      const signedXdr = buildSignedXdr();

      jest.spyOn(rpc.Server.prototype, "sendTransaction").mockRejectedValue(new Error("connection refused"));

      const result = await service.submit(signedXdr);

      expect(result.confirmed).toBe(false);
      expect(result.error).toBe("connection refused");
    });

    it("captures and returns the u64 ID returned by a confirmed buy_policy call", async () => {
      const policyService = { confirmPurchase: jest.fn() };
      const service = buildService(policyService);
      const signedXdr = buildSignedBuyXdr();
      const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
      const txHash = tx.hash().toString("hex");

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
        returnValue: nativeToScVal(73n, { type: "u64" }),
      });

      const result = await service.submit(signedXdr);

      expect(result).toEqual({ confirmed: true, txHash: "mock-tx-hash", policyId: "73" });
      expect(policyService.confirmPurchase).toHaveBeenCalledWith(txHash, "73");
    });

    it("activates the pending buy under the real on-chain ID after confirmation", async () => {
      const policyService = new PolicyService(buildConfig());
      jest.spyOn(policyService, "onChainCoverageBounds").mockResolvedValue(null);
      const holder = Keypair.random();
      jest
        .spyOn(rpc.Server.prototype, "getAccount")
        .mockImplementation(async (publicKey: string) => new Account(publicKey, "1"));
      jest.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) => tx as never);

      const buyDto: BuyPolicyDto = {
        holder: holder.publicKey(),
        coverageType: 0,
        coverageAmount: "10000000000",
        durationDays: 30,
      };
      const { policy: pendingPolicy, txXdr } = await policyService.buy(buyDto);
      const signedTx = TransactionBuilder.fromXDR(txXdr, NETWORK_PASSPHRASE);
      signedTx.sign(holder);

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
        returnValue: nativeToScVal(9876543210123456789n, { type: "u64" }),
      });

      const result = await buildService(policyService).submit(signedTx.toXDR());

      expect(pendingPolicy.id).toBeNull();
      expect(result).toMatchObject({ confirmed: true, policyId: "9876543210123456789" });
      expect(policyService.findById("9876543210123456789")).toMatchObject({
        id: "9876543210123456789",
        holder: holder.publicKey(),
        isActive: true,
      });
    });
  });
});
