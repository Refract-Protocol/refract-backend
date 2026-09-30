import { ConfigService } from "@nestjs/config";
import { Account, Keypair, StrKey, TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { OraclePublisherService } from "./oracle-publisher.service";
import { scaleOracleValue, coverageTypeToU32 } from "./oracle-encoding";
import { OracleReading } from "./oracle-reading";

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

function buildConfig(
  stellarOverrides: Partial<AppConfig["stellar"]> = {},
  publishOverrides: Partial<AppConfig["oraclePublish"]> = {}
): ConfigService<AppConfig, true> {
  const stellar: AppConfig["stellar"] = {
    network: "testnet",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: NETWORK_PASSPHRASE,
    poolContractId: "",
    policyContractId: "",
    oracleContractId: StrKey.encodeContract(Buffer.alloc(32, 2)),
    relayerSecret: Keypair.random().secret(),
    ...stellarOverrides,
  };
  const oraclePublish: AppConfig["oraclePublish"] = {
    mode: "every_poll",
    minIntervalMs: 0,
    ...publishOverrides,
  };
  return {
    get: jest.fn((key: string) => {
      if (key === "stellar") return stellar;
      if (key === "confirmation") return CONFIRMATION;
      if (key === "oraclePublish") return oraclePublish;
      return undefined;
    }),
  } as unknown as ConfigService<AppConfig, true>;
}

function reading(overrides: Partial<OracleReading> = {}): OracleReading {
  return {
    coverageType: "StablecoinDepeg",
    type: "oracle_update",
    value: 0.9998,
    threshold: 0.95,
    severity: "low",
    message: "ok",
    ...overrides,
  };
}

const PENDING_SEND_RESULT = { status: "PENDING" as const, hash: "oracle-tx", latestLedger: 1, latestLedgerCloseTime: 1 };

describe("oracle encoding", () => {
  it("scales each coverage type deterministically", () => {
    expect(scaleOracleValue("StablecoinDepeg", 0.9998)).toBe(9_998_000n);
    expect(scaleOracleValue("MarketCrash", -30.12)).toBe(-3012n);
    expect(scaleOracleValue("LiquidationShield", 0.42)).toBe(4200n);
    expect(scaleOracleValue("SmartContractRisk", -50)).toBe(-5000n);
    expect(scaleOracleValue("FlightDelay", 247.4)).toBe(247n);
  });

  it("maps coverage type names to u32 discriminants", () => {
    expect(coverageTypeToU32("FlightDelay")).toBe(4);
  });
});

describe("OraclePublisherService", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("degrades without throwing when oracleContractId is missing", async () => {
    const service = new OraclePublisherService(buildConfig({ oracleContractId: "" }));
    const getAccountSpy = jest.spyOn(rpc.Server.prototype, "getAccount");

    const result = await service.maybePublish(reading());

    expect(result).toBeNull();
    expect(service.isConfigured()).toBe(false);
    expect(getAccountSpy).not.toHaveBeenCalled();
  });

  it("never publishes a degraded reading", async () => {
    const service = new OraclePublisherService(buildConfig());
    const getAccountSpy = jest.spyOn(rpc.Server.prototype, "getAccount");

    const result = await service.maybePublish(reading({ degraded: true }));

    expect(result).toBeNull();
    expect(getAccountSpy).not.toHaveBeenCalled();
  });

  it("encodes update_reading(u32, i128) with the scaled value", async () => {
    const service = new OraclePublisherService(buildConfig());

    jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(Keypair.random().publicKey(), "1"));
    const prepareSpy = jest
      .spyOn(rpc.Server.prototype, "prepareTransaction")
      .mockImplementation(async (tx) => tx as never);
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

    const result = await service.maybePublish(reading({ coverageType: "MarketCrash", value: -30.12 }));

    expect(result?.confirmed).toBe(true);
    const builtTx = prepareSpy.mock.calls[0][0] as ReturnType<TransactionBuilder["build"]>;
    const op = builtTx.operations[0] as { func: xdr.HostFunction };
    const invocation = op.func.invokeContract();
    expect(invocation.functionName().toString()).toBe("update_reading");
    const args = [...invocation.args()];
    expect(args).toHaveLength(2);
    expect(scValToNative(args[0])).toBe(1); // MarketCrash
    expect(scValToNative(args[1])).toBe(-3012n);
    expect(args[1].toXDR("base64")).toBe(nativeToScVal(-3012n, { type: "i128" }).toXDR("base64"));
  });

  it("suppresses overlapping publishes for the same coverage type", async () => {
    const service = new OraclePublisherService(buildConfig());
    let releaseGetAccount!: (account: Account) => void;
    const gate = new Promise<Account>((resolve) => {
      releaseGetAccount = resolve;
    });

    jest.spyOn(rpc.Server.prototype, "getAccount").mockReturnValue(gate as never);
    jest.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) => tx as never);
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

    const first = service.maybePublish(reading({ value: 0.99 }));
    const second = await service.maybePublish(reading({ value: 0.98 }));
    expect(second).toBeNull();

    releaseGetAccount(new Account(Keypair.random().publicKey(), "1"));
    const firstResult = await first;
    expect(firstResult?.confirmed).toBe(true);
  });

  it("records confirmation failures in the audit log rather than swallowing them", async () => {
    const service = new OraclePublisherService(buildConfig());

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

    const result = await service.maybePublish(reading());

    expect(result?.confirmed).toBe(false);
    expect(result?.error).toContain("failed on-chain");
    expect(service.getAuditLog()).toHaveLength(1);
    expect(service.getAuditLog()[0].txHash).toBe("oracle-tx");
  });

  it("skips publish when on_change mode sees an unchanged scaled value", async () => {
    const service = new OraclePublisherService(buildConfig({}, { mode: "on_change", minIntervalMs: 0 }));

    jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(Keypair.random().publicKey(), "1"));
    jest.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) => tx as never);
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

    await service.maybePublish(reading({ value: 1.0 }));
    const sendSpy = jest.spyOn(rpc.Server.prototype, "sendTransaction");
    sendSpy.mockClear();

    const second = await service.maybePublish(reading({ value: 1.0 }));
    expect(second).toBeNull();
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
