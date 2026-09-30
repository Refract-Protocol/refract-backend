import { ConfigService } from "@nestjs/config";
import {
  Account,
  BASE_FEE,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { testStellarConfig } from "../config/test-stellar";
import {
  RelayerAccountService,
  RelayerInsufficientBalanceError,
  RelayerSequenceExhaustedError,
} from "./relayer-account.service";

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

function buildConfig(
  overrides: Partial<AppConfig["stellar"]> = {},
  secret?: string
): ConfigService<AppConfig, true> {
  const stellar = testStellarConfig({
    relayerSecret: secret ?? Keypair.random().secret(),
    ...overrides,
  });
  return {
    get: jest.fn((key: string) => {
      if (key === "stellar") return stellar;
      return undefined;
    }),
  } as unknown as ConfigService<AppConfig, true>;
}

function signedBumpTx(keypair: Keypair, sequence = "1"): Transaction {
  const account = new Account(keypair.publicKey(), sequence);
  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: String(Number(sequence) + 1) }))
    .setTimeout(30)
    .build();
}

describe("RelayerAccountService", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("is not configured when the relayer secret is missing", () => {
    const service = new RelayerAccountService(buildConfig({ relayerSecret: "" }, ""));
    expect(service.isConfigured()).toBe(false);
    expect(service.isReady()).toBe(false);
  });

  it("allocates distinct sequences under concurrent callers with no duplicates", async () => {
    const keypair = Keypair.random();
    const service = new RelayerAccountService(buildConfig({}, keypair.secret()));
    const sequences: string[] = [];

    jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(keypair.publicKey(), "10"));
    jest.spyOn(rpc.Server.prototype, "getFeeStats").mockResolvedValue({
      sorobanInclusionFee: { p50: "100", mode: "100" },
      inclusionFee: { p50: "100", mode: "100" },
      latestLedger: 1,
    } as never);
    jest.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue({
      status: "PENDING",
      hash: "h",
      latestLedger: 1,
      latestLedgerCloseTime: 1,
    });

    const buildFn = async (account: Account) => {
      sequences.push(account.sequenceNumber());
      return signedBumpTx(keypair, account.sequenceNumber());
    };

    await Promise.all([
      service.submitRelayerTransaction(buildFn),
      service.submitRelayerTransaction(buildFn),
      service.submitRelayerTransaction(buildFn),
    ]);

    expect(new Set(sequences).size).toBe(3);
    expect(sequences).toEqual(["10", "11", "12"]);
  });

  it("rebuilds after txBAD_SEQ by re-syncing sequence", async () => {
    const keypair = Keypair.random();
    const service = new RelayerAccountService(
      buildConfig(
        {
          relayer: {
            feeMultiplier: 1.2,
            feeCeiling: 1_000_000,
            idleResyncMs: 30_000,
            minBalance: 50_000_000,
            maxAttempts: 3,
          },
        },
        keypair.secret()
      )
    );

    let getAccountCalls = 0;
    jest.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(async () => {
      getAccountCalls += 1;
      return new Account(keypair.publicKey(), getAccountCalls === 1 ? "5" : "7");
    });
    jest.spyOn(rpc.Server.prototype, "getFeeStats").mockResolvedValue({
      sorobanInclusionFee: { p50: "100", mode: "100" },
      inclusionFee: { p50: "100", mode: "100" },
      latestLedger: 1,
    } as never);

    let attempt = 0;
    jest.spyOn(rpc.Server.prototype, "sendTransaction").mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) {
        return {
          status: "ERROR",
          hash: "bad",
          latestLedger: 1,
          latestLedgerCloseTime: 1,
          errorResult: "txBAD_SEQ",
        } as never;
      }
      return { status: "PENDING", hash: "ok-hash", latestLedger: 1, latestLedgerCloseTime: 1 };
    });

    const buildSequences: string[] = [];
    const result = await service.submitRelayerTransaction(async (account) => {
      buildSequences.push(account.sequenceNumber());
      return signedBumpTx(keypair, account.sequenceNumber());
    });

    expect(result.hash).toBe("ok-hash");
    expect(buildSequences).toEqual(["5", "7"]);
  });

  it("enforces the attempt cap and throws RelayerSequenceExhaustedError", async () => {
    const keypair = Keypair.random();
    const service = new RelayerAccountService(
      buildConfig(
        {
          relayer: {
            feeMultiplier: 1.2,
            feeCeiling: 1_000_000,
            idleResyncMs: 30_000,
            minBalance: 50_000_000,
            maxAttempts: 2,
          },
        },
        keypair.secret()
      )
    );

    jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(keypair.publicKey(), "1"));
    jest.spyOn(rpc.Server.prototype, "getFeeStats").mockResolvedValue({
      sorobanInclusionFee: { p50: "100", mode: "100" },
      inclusionFee: { p50: "100", mode: "100" },
      latestLedger: 1,
    } as never);
    jest.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue({
      status: "ERROR",
      hash: "bad",
      latestLedger: 1,
      latestLedgerCloseTime: 1,
      errorResult: "txBAD_SEQ",
    } as never);

    await expect(
      service.submitRelayerTransaction(async (account) => signedBumpTx(keypair, account.sequenceNumber()))
    ).rejects.toBeInstanceOf(RelayerSequenceExhaustedError);
  });

  it("derives fees from stats and clamps at the ceiling", async () => {
    const keypair = Keypair.random();
    const service = new RelayerAccountService(
      buildConfig(
        {
          relayer: {
            feeMultiplier: 2,
            feeCeiling: 500,
            idleResyncMs: 30_000,
            minBalance: 50_000_000,
            maxAttempts: 3,
          },
        },
        keypair.secret()
      )
    );

    jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(keypair.publicKey(), "1"));
    jest.spyOn(rpc.Server.prototype, "getFeeStats").mockResolvedValue({
      sorobanInclusionFee: { p50: "1000", mode: "1000" },
      inclusionFee: { p50: "1000", mode: "1000" },
      latestLedger: 1,
    } as never);
    jest.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue({
      status: "PENDING",
      hash: "fee-hash",
      latestLedger: 1,
      latestLedgerCloseTime: 1,
    });

    let seenFee = "";
    await service.submitRelayerTransaction(async (account, fee) => {
      seenFee = fee;
      return signedBumpTx(keypair, account.sequenceNumber());
    });

    expect(seenFee).toBe("500");
  });

  it("blocks submission with RelayerInsufficientBalanceError when balance cannot cover fees", async () => {
    const keypair = Keypair.random();
    const service = new RelayerAccountService(
      buildConfig(
        {
          relayer: {
            feeMultiplier: 1.2,
            feeCeiling: 1_000_000,
            idleResyncMs: 30_000,
            minBalance: 50_000_000,
            maxAttempts: 3,
          },
        },
        keypair.secret()
      )
    );

    jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(
      Object.assign(new Account(keypair.publicKey(), "1"), {
        balances: [{ asset_type: "native", balance: "0.0000001" }],
      }) as Account
    );
    jest.spyOn(rpc.Server.prototype, "getFeeStats").mockResolvedValue({
      sorobanInclusionFee: { p50: String(BASE_FEE), mode: String(BASE_FEE) },
      inclusionFee: { p50: String(BASE_FEE), mode: String(BASE_FEE) },
      latestLedger: 1,
    } as never);

    await expect(
      service.submitRelayerTransaction(async (account) => signedBumpTx(keypair, account.sequenceNumber()))
    ).rejects.toBeInstanceOf(RelayerInsufficientBalanceError);
  });

  it("preserves queue ordering across overlapping submissions", async () => {
    const keypair = Keypair.random();
    const service = new RelayerAccountService(buildConfig({}, keypair.secret()));
    const order: number[] = [];

    jest.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(keypair.publicKey(), "1"));
    jest.spyOn(rpc.Server.prototype, "getFeeStats").mockResolvedValue({
      sorobanInclusionFee: { p50: "100", mode: "100" },
      inclusionFee: { p50: "100", mode: "100" },
      latestLedger: 1,
    } as never);
    jest.spyOn(rpc.Server.prototype, "sendTransaction").mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { status: "PENDING", hash: "h", latestLedger: 1, latestLedgerCloseTime: 1 };
    });

    const jobs = [1, 2, 3].map((n) =>
      service.submitRelayerTransaction(async (account) => {
        order.push(n);
        return signedBumpTx(keypair, account.sequenceNumber());
      })
    );
    await Promise.all(jobs);
    expect(order).toEqual([1, 2, 3]);
  });
});
