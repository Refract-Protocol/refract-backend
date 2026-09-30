import { Account, Keypair, rpc } from "@stellar/stellar-sdk";
import { SorobanRpcClient } from "./soroban-rpc.client";

describe("SorobanRpcClient", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("retries transient failures with bounded backoff", async () => {
    jest.useFakeTimers();
    const account = new Account(Keypair.random().publicKey(), "1");
    const getAccount = jest
      .spyOn(rpc.Server.prototype, "getAccount")
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValue(account);
    const client = new SorobanRpcClient(["https://rpc.example"]);

    const accountPromise = client.call((server) => server.getAccount(account.accountId()));
    await jest.runAllTimersAsync();

    await expect(accountPromise).resolves.toBe(account);
    expect(getAccount).toHaveBeenCalledTimes(2);
  });

  it("fails over to the next configured endpoint after a transient failure", async () => {
    const account = new Account(Keypair.random().publicKey(), "1");
    const getAccount = jest
      .spyOn(rpc.Server.prototype, "getAccount")
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValue(account);
    const client = new SorobanRpcClient(["https://primary.example", "https://backup.example"]);

    await expect(client.call((server) => server.getAccount(account.accountId()))).resolves.toBe(account);
    expect(getAccount).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-transient RPC errors", async () => {
    const error = new Error("invalid contract arguments");
    const getAccount = jest.spyOn(rpc.Server.prototype, "getAccount").mockRejectedValue(error);
    const client = new SorobanRpcClient(["https://rpc.example"]);

    const publicKey = Keypair.random().publicKey();
    await expect(client.call((server) => server.getAccount(publicKey))).rejects.toBe(error);
    expect(getAccount).toHaveBeenCalledTimes(1);
  });
});
