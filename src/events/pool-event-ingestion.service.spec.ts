import { ConfigService } from "@nestjs/config";
import {
  Address,
  Contract,
  Keypair,
  StrKey,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { normalizePoolEvent, PoolEventIngestionService } from "./pool-event-ingestion.service";

const POOL_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

function buildConfig(): ConfigService<AppConfig, true> {
  const stellar: AppConfig["stellar"] = {
    network: "testnet",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    sorobanRpcUrls: ["https://soroban-testnet.stellar.org"],
    eventStartLedger: 50,
    networkPassphrase: NETWORK_PASSPHRASE,
    poolContractId: POOL_CONTRACT_ID,
    policyContractId: "",
    oracleContractId: "",
    relayerSecret: "",
  };
  return {
    get: jest.fn((key: string) => (key === "stellar" ? stellar : "postgres://localhost/refract")),
  } as unknown as ConfigService<AppConfig, true>;
}

function contractEvent(
  name: string,
  holder: string,
  values: xdr.ScVal[],
  overrides: Partial<rpc.Api.EventResponse> = {}
): rpc.Api.EventResponse {
  return {
    id: `event-${name.toLowerCase()}`,
    type: "contract",
    contractId: new Contract(POOL_CONTRACT_ID),
    topic: [xdr.ScVal.scvSymbol(name), new Address(holder).toScVal()],
    value: xdr.ScVal.scvVec(values),
    ledger: 75,
    ledgerClosedAt: "2026-09-28T21:00:00Z",
    pagingToken: "cursor-75-event-1",
    inSuccessfulContractCall: true,
    txHash: "a".repeat(64),
    ...overrides,
  };
}

describe("PoolEventIngestionService", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("normalizes policy purchases with the real on-chain policy id and payload", () => {
    const holder = Keypair.random().publicKey();
    const event = contractEvent("BUY", holder, [
      nativeToScVal(42n, { type: "u64" }),
      nativeToScVal(500_000_000n, { type: "i128" }),
      nativeToScVal(10_000_000n, { type: "i128" }),
      nativeToScVal(1_800_000_000n, { type: "u64" }),
    ]);

    const normalized = normalizePoolEvent(event);
    expect(normalized).not.toBeNull();
    if (!normalized) throw new Error("BUY event did not normalize");

    expect(normalized).toMatchObject({
      eventId: "event-buy",
      contractId: POOL_CONTRACT_ID,
      eventType: "POLICY_PURCHASED",
      holder,
      policyId: "42",
      amount: "500000000",
      secondaryAmount: "10000000",
      expiresAt: "1800000000",
    });
    expect(JSON.parse(normalized.payload)).toEqual({
      topics: ["BUY", holder],
      value: ["42", "500000000", "10000000", "1800000000"],
    });
  });

  it("polls from the saved ledger, persists events idempotently, and advances the checkpoint", async () => {
    const holder = Keypair.random().publicKey();
    const event = contractEvent("PROVIDE", holder, [
      nativeToScVal(100_000_000n, { type: "i128" }),
      nativeToScVal(90_000_000n, { type: "i128" }),
    ]);
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const databaseClient = {
      query: jest.fn(async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        if (text.includes("SELECT cursor")) {
          return { rows: [{ cursor: null, next_start_ledger: "50" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: jest.fn(),
    };
    const databasePool = {
      connect: jest.fn().mockResolvedValue(databaseClient),
      end: jest.fn(),
    };
    const service = new PoolEventIngestionService(buildConfig());
    Object.defineProperty(service, "pool", { value: databasePool });
    jest.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValue({
      latestLedger: 80,
      events: [event],
    });

    await service.pollPoolEvents();

    const eventInsert = queries.find(({ text }) => text.includes("INSERT INTO soroban_pool_events"));
    expect(eventInsert?.values).toEqual([
      "event-provide",
      "cursor-75-event-1",
      POOL_CONTRACT_ID,
      "CAPITAL_PROVIDED",
      75,
      "a".repeat(64),
      "2026-09-28T21:00:00Z",
      holder,
      null,
      "100000000",
      "90000000",
      null,
      JSON.stringify({ topics: ["PROVIDE", holder], value: ["100000000", "90000000"] }),
    ]);
    expect(queries.find(({ text }) => text.includes("UPDATE soroban_event_cursors"))?.values).toEqual([
      POOL_CONTRACT_ID,
      null,
      81,
    ]);
    expect(queries.some(({ text }) => text === "COMMIT")).toBe(true);
    expect(databaseClient.release).toHaveBeenCalledTimes(1);
  });

  it("rolls back the cursor when the RPC request fails", async () => {
    const queries: string[] = [];
    const databaseClient = {
      query: jest.fn(async (text: string) => {
        queries.push(text);
        if (text.includes("SELECT cursor")) {
          return { rows: [{ cursor: null, next_start_ledger: "50" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: jest.fn(),
    };
    const databasePool = { connect: jest.fn().mockResolvedValue(databaseClient), end: jest.fn() };
    const service = new PoolEventIngestionService(buildConfig());
    Object.defineProperty(service, "pool", { value: databasePool });
    jest.spyOn(rpc.Server.prototype, "getEvents").mockRejectedValue(new Error("connection refused"));

    await service.pollPoolEvents();

    expect(queries).toContain("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
  });
});
