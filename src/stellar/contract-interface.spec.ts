import { ConfigService } from "@nestjs/config";
import { Account, Contract, Keypair, StrKey, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import contractInterface from "./contract-interface.json";
import { AppConfig } from "../config/configuration";
import { ClaimSettlementService } from "../claim/claim-settlement.service";
import { PoolService } from "../pool/pool.service";
import { PolicyService } from "../policy/policy.service";

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const POOL_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));

function buildConfig(): ConfigService<AppConfig, true> {
  const stellar: AppConfig["stellar"] = {
    network: "testnet",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: NETWORK_PASSPHRASE,
    poolContractId: POOL_CONTRACT_ID,
    policyContractId: "",
    oracleContractId: "",
    relayerSecret: Keypair.random().secret(),
  };
  return { get: jest.fn().mockReturnValue(stellar) } as unknown as ConfigService<AppConfig, true>;
}

function scValShape(value: ReturnType<typeof nativeToScVal>): unknown {
  const type = value.switch().name.replace(/^scv/, "").toLowerCase();
  if (type === "map") {
    return {
      type,
      fields: value.map()!.map((entry) => [
        entry.key().sym().toString(),
        scValShape(entry.val()),
      ]),
    };
  }
  if (type === "vec") {
    return { type, items: value.vec()!.map(scValShape) };
  }
  return type;
}

describe("Soroban contract call interface", () => {
  afterEach(() => jest.restoreAllMocks());

  it("keeps every submitted/read ScVal argument shape aligned with the checked-in contract interface", async () => {
    const holder = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();
    const contractCallSpy = jest.spyOn(Contract.prototype, "call");
    jest.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(async (id: string) => new Account(id, "1"));
    jest.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) => tx as never);
    jest.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue({
      result: { retval: nativeToScVal(null), auth: [] },
    } as unknown as rpc.Api.SimulateTransactionResponse);
    jest.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue({
      status: "ERROR",
      hash: "unused",
      latestLedger: 1,
      latestLedgerCloseTime: 1,
    });

    const pool = new PoolService(buildConfig());
    await pool.lockupExpiresAt(holder);
    await pool.provide({ provider: holder, amount: "100" });
    await pool.withdraw({ provider: holder, shares: "100" });

    const policy = new PolicyService(buildConfig());
    await policy.buy({
      holder,
      coverageType: 0,
      coverageAmount: "10000000000",
      durationDays: 30,
    });

    const claims = new ClaimSettlementService(buildConfig());
    await claims.settleClaim("7");

    const observed = Object.fromEntries(
      contractCallSpy.mock.calls.map(([method, ...args]) => [
        method,
        args.map((arg) => scValShape(arg)),
      ])
    );
    expect(observed).toEqual(contractInterface);
  });
});
