import {
  Account,
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import { decodeErrorResult, submitAndConfirm } from "./transaction-submitter";

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

function buildSignedTx() {
  const signer = Keypair.random();
  const account = new Account(signer.publicKey(), "1");
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
    .setTimeout(30)
    .build();
  tx.sign(signer);
  return tx;
}

function mockServer(overrides: Partial<rpc.Server> = {}): rpc.Server {
  return {
    sendTransaction: jest.fn(),
    getTransaction: jest.fn(),
    ...overrides,
  } as unknown as rpc.Server;
}

describe("transaction-submitter", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe("decodeErrorResult", () => {
    it("maps txINSUFFICIENT_FEE from a TransactionResult-shaped object", () => {
      const fake = {
        result: () => ({
          switch: () => ({ name: "txINSUFFICIENT_FEE" }),
        }),
      };
      expect(decodeErrorResult(fake).code).toBe("txINSUFFICIENT_FEE");
    });

    it("maps txNO_ACCOUNT and txINSUFFICIENT_BALANCE", () => {
      expect(
        decodeErrorResult({ result: () => ({ switch: () => ({ name: "txNO_ACCOUNT" }) }) }).code
      ).toBe("txNO_ACCOUNT");
      expect(
        decodeErrorResult({ result: () => ({ switch: () => ({ name: "txINSUFFICIENT_BALANCE" }) }) }).code
      ).toBe("txINSUFFICIENT_BALANCE");
    });

    it("returns UNKNOWN when errorResult is missing", () => {
      expect(decodeErrorResult(undefined).code).toBe("UNKNOWN");
    });
  });

  describe("submitAndConfirm", () => {
    it("routes PENDING to confirmation polling", async () => {
      const tx = buildSignedTx();
      const server = mockServer({
        sendTransaction: jest.fn().mockResolvedValue({ status: "PENDING", hash: "h1" }),
        getTransaction: jest.fn().mockResolvedValue({ status: rpc.Api.GetTransactionStatus.SUCCESS }),
      });

      const result = await submitAndConfirm(server, tx);
      expect(result).toEqual({ confirmed: true, txHash: "h1" });
    });

    it("routes DUPLICATE to polling (benign mempool case)", async () => {
      const tx = buildSignedTx();
      const server = mockServer({
        sendTransaction: jest.fn().mockResolvedValue({ status: "DUPLICATE", hash: "h-dup" }),
        getTransaction: jest.fn().mockResolvedValue({ status: rpc.Api.GetTransactionStatus.SUCCESS }),
      });

      const result = await submitAndConfirm(server, tx);
      expect(result.confirmed).toBe(true);
      expect(result.txHash).toBe("h-dup");
    });

    it("retries TRY_AGAIN_LATER with backoff using the identical envelope, then succeeds", async () => {
      jest.useFakeTimers();
      const tx = buildSignedTx();
      const fingerprint = tx.toXDR();
      const send = jest
        .fn()
        .mockResolvedValueOnce({ status: "TRY_AGAIN_LATER", hash: "h-retry" })
        .mockResolvedValueOnce({ status: "PENDING", hash: "h-retry" });
      const server = mockServer({
        sendTransaction: send,
        getTransaction: jest.fn().mockResolvedValue({ status: rpc.Api.GetTransactionStatus.SUCCESS }),
      });

      const promise = submitAndConfirm(server, tx, {
        validityWindowMs: 10_000,
        initialBackoffMs: 100,
        maxRetries: 3,
      });
      await jest.advanceTimersByTimeAsync(100);
      const result = await promise;

      expect(result.confirmed).toBe(true);
      expect(send).toHaveBeenCalledTimes(2);
      // Envelope fingerprint unchanged across retries
      expect(tx.toXDR()).toBe(fingerprint);
    });

    it("exhausts TRY_AGAIN_LATER within the validity window and returns 503 semantics", async () => {
      jest.useFakeTimers();
      const tx = buildSignedTx();
      const send = jest.fn().mockResolvedValue({ status: "TRY_AGAIN_LATER", hash: "h-cong" });
      const server = mockServer({ sendTransaction: send, getTransaction: jest.fn() });

      const promise = submitAndConfirm(server, tx, {
        validityWindowMs: 500,
        initialBackoffMs: 200,
        maxRetries: 5,
      });
      await jest.advanceTimersByTimeAsync(2000);
      const result = await promise;

      expect(result.confirmed).toBe(false);
      expect(result.httpStatus).toBe(503);
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
      expect(server.getTransaction).not.toHaveBeenCalled();
    });

    it("never retries ERROR and decodes errorResult into a 400 result", async () => {
      const tx = buildSignedTx();
      const send = jest.fn().mockResolvedValue({
        status: "ERROR",
        hash: "h-err",
        errorResult: {
          result: () => ({ switch: () => ({ name: "txBAD_SEQ" }) }),
        },
      });
      const server = mockServer({ sendTransaction: send, getTransaction: jest.fn() });

      const result = await submitAndConfirm(server, tx);
      expect(result.confirmed).toBe(false);
      expect(result.httpStatus).toBe(400);
      expect(result.resultCode).toBe("txBAD_SEQ");
      expect(send).toHaveBeenCalledTimes(1);
      expect(server.getTransaction).not.toHaveBeenCalled();
    });
  });
});
