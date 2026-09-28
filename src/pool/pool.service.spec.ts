import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Account,
  Keypair,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { LpPositionRepository } from "./lp-position.repository";
import { PoolSnapshotRepository } from "./pool-snapshot.repository";
import { PoolService, PoolStats } from "./pool.service";
import { PremiumRevenueRepository } from "./premium-revenue.repository";

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const POOL_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));

// A realistic pool snapshot — same numbers the old mockPool used, so
// tests that relied on those literals stay comparable.
const SNAPSHOT = {
  totalUsdc: BigInt(18_400_000 * 1e7),
  totalShares: BigInt(17_800_000 * 1e7),
  lockedUsdc: BigInt(2_900_000 * 1e7),
  premiumAccrued: BigInt(284_000 * 1e7),
  sharePrice: 1.0319,
  utilizationBps: 1576,
  apyBps: 890,
};

function buildConfig(overrides: Partial<AppConfig["stellar"]> = {}): ConfigService<AppConfig, true> {
  const stellar: AppConfig["stellar"] = {
    network: "testnet",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: NETWORK_PASSPHRASE,
    poolContractId: POOL_CONTRACT_ID,
    policyContractId: "",
    oracleContractId: "",
    relayerSecret: "",
    ...overrides,
  };
  return { get: jest.fn().mockReturnValue(stellar) } as unknown as ConfigService<AppConfig, true>;
}

function buildRepos(snapshotOverride?: typeof SNAPSHOT | null) {
  const poolSnapshotRepository = {
    getLatest: jest.fn().mockResolvedValue(snapshotOverride === undefined ? SNAPSHOT : snapshotOverride),
    toStats: jest.fn().mockImplementation((snap: typeof SNAPSHOT): PoolStats => ({
      totalUsdc: snap.totalUsdc.toString(),
      totalShares: snap.totalShares.toString(),
      lockedUsdc: snap.lockedUsdc.toString(),
      premiumAccrued: snap.premiumAccrued.toString(),
      availableUsdc: (snap.totalUsdc - snap.lockedUsdc).toString(),
      utilizationBps: snap.utilizationBps,
      apyBps: snap.apyBps,
      sharePrice: snap.sharePrice,
      maxUtilizationBps: 8000,
    })),
    insert: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<PoolSnapshotRepository>;

  const lpPositionRepository = {
    findByProvider: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<LpPositionRepository>;

  const premiumRevenueRepository = {
    record: jest.fn().mockResolvedValue(undefined),
    getDailyHistory: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<PremiumRevenueRepository>;

  return { poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository };
}

/** Decodes the single invokeHostFunction operation out of a built (unsigned) tx envelope. */
function decodeInvocation(txXdr: string) {
  const tx = TransactionBuilder.fromXDR(txXdr, NETWORK_PASSPHRASE) as Transaction;
  const op = tx.operations[0] as Extract<Transaction["operations"][number], { type: "invokeHostFunction" }>;
  const invocation = op.func.invokeContract();
  return {
    functionName: invocation.functionName().toString(),
    args: invocation.args().map((arg) => scValToNative(arg)),
  };
}

/** A minimal simulateTransaction success response carrying just a return value. */
function simulateSuccess(retval: xdr.ScVal): rpc.Api.SimulateTransactionResponse {
  return { result: { retval, auth: [] } } as unknown as rpc.Api.SimulateTransactionResponse;
}

describe("PoolService", () => {
  let provider: string;

  beforeEach(() => {
    provider = Keypair.random().publicKey();
    jest.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(async (id: string) => new Account(id, "1"));
    jest.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) => tx as never);
    // Default: no lockup (Option<u64>::None -> ScVal::Void)
    jest.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue(simulateSuccess(xdr.ScVal.scvVoid()));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("getStats", () => {
    it("derives availableUsdc from totalUsdc minus lockedUsdc and echoes the snapshot state", async () => {
      const { poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository } = buildRepos();
      const service = new PoolService(buildConfig(), poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository);

      const stats = await service.getStats();

      expect(stats.totalUsdc).toBe(SNAPSHOT.totalUsdc.toString());
      expect(stats.totalShares).toBe(SNAPSHOT.totalShares.toString());
      expect(stats.lockedUsdc).toBe(SNAPSHOT.lockedUsdc.toString());
      expect(stats.premiumAccrued).toBe(SNAPSHOT.premiumAccrued.toString());
      expect(stats.availableUsdc).toBe((SNAPSHOT.totalUsdc - SNAPSHOT.lockedUsdc).toString());
      expect(stats.utilizationBps).toBe(SNAPSHOT.utilizationBps);
      expect(stats.apyBps).toBe(SNAPSHOT.apyBps);
      expect(stats.sharePrice).toBe(SNAPSHOT.sharePrice);
      expect(stats.maxUtilizationBps).toBe(8000);
      expect(stats.stale).toBeUndefined();
    });

    it("returns stale bootstrap stats (stale: true) when no snapshot exists yet", async () => {
      const { poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository } = buildRepos(null);
      const service = new PoolService(buildConfig(), poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository);

      const stats = await service.getStats();

      expect(stats.totalUsdc).toBe("0");
      expect(stats.stale).toBe(true);
    });
  });

  describe("getUserPosition", () => {
    it("returns zero position for an address not in lp_positions", async () => {
      const { poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository } = buildRepos();
      lpPositionRepository.findByProvider.mockResolvedValue(null);
      const service = new PoolService(buildConfig(), poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository);

      const position = await service.getUserPosition("GPROVIDER_NOT_FOUND");

      expect(position.shares).toBe("0");
      expect(position.usdcValue).toBe("0");
      expect(position.premiumEarned).toBe("0");
      expect(position.pct).toBe("0.0000");
      expect(position.deposited).toBe(false);
    });

    it("returns real position data when the provider has an lp_positions row", async () => {
      const { poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository } = buildRepos();
      const shares = BigInt(Math.floor(30_000 * 1e7));
      lpPositionRepository.findByProvider.mockResolvedValue({
        provider,
        shares,
        usdcDeposited: BigInt(30_000 * 1e7),
        premiumEarned: BigInt(500 * 1e7),
        firstDeposit: new Date("2025-01-01"),
        lastUpdated: new Date("2025-06-01"),
      });
      const service = new PoolService(buildConfig(), poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository);

      const position = await service.getUserPosition(provider);

      expect(position.address).toBe(provider);
      expect(position.shares).toBe(shares.toString());
      expect(position.deposited).toBe(true);
      expect(position.premiumEarned).toBe((BigInt(500 * 1e7)).toString());
      // usdcValue = shares * sharePrice
      const expectedUsdcValue = Number(shares) * SNAPSHOT.sharePrice;
      expect(position.usdcValue).toBe(expectedUsdcValue.toFixed(0));
    });
  });

  describe("provide", () => {
    it("computes sharesOut proportionally to the snapshot share price and returns an unsigned provide_capital invocation", async () => {
      const { poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository } = buildRepos();
      const service = new PoolService(buildConfig(), poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository);
      const amount = (184_000n * 10_000_000n).toString();

      const result = await service.provide({ provider, amount });

      const expectedShares = (BigInt(amount) * SNAPSHOT.totalShares) / SNAPSHOT.totalUsdc;
      expect(result.sharesOut).toBe(expectedShares.toString());
      expect(result.amountUsdc).toBe(amount);
      expect(result.sharePrice).toBe(SNAPSHOT.sharePrice);

      const { functionName, args } = decodeInvocation(result.txXdr);
      expect(functionName).toBe("provide_capital");
      expect(args).toEqual([provider, BigInt(amount)]);
    });

    it("rejects a zero-amount deposit without contacting the network", async () => {
      const { poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository } = buildRepos();
      const service = new PoolService(buildConfig(), poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository);
      const getAccountSpy = jest.spyOn(rpc.Server.prototype, "getAccount");
      expect.assertions(3);

      try {
        await service.provide({ provider, amount: "0" });
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const response = (err as BadRequestException).getResponse() as { error: string };
        expect(response.error).toBe("Deposit amount must be greater than zero");
        expect(getAccountSpy).not.toHaveBeenCalled();
      }
    });

    it("wraps a Soroban build failure in a BadRequestException", async () => {
      const { poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository } = buildRepos();
      const service = new PoolService(buildConfig(), poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository);
      jest.spyOn(rpc.Server.prototype, "prepareTransaction").mockRejectedValue(new Error("InsufficientCapacity"));
      expect.assertions(2);

      try {
        await service.provide({ provider, amount: "100" });
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const response = (err as BadRequestException).getResponse() as { error: string };
        expect(response.error).toContain("InsufficientCapacity");
      }
    });
  });

  describe("withdraw", () => {
    it("computes usdcOut proportionally and returns an unsigned withdraw_capital invocation when within available capacity", async () => {
      const { poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository } = buildRepos();
      const service = new PoolService(buildConfig(), poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository);
      const shares = (1_000_000n * 10_000_000n).toString();

      const result = await service.withdraw({ provider, shares });

      const expectedUsdcOut = (BigInt(shares) * SNAPSHOT.totalUsdc) / SNAPSHOT.totalShares;
      expect(result.usdcOut).toBe(expectedUsdcOut.toString());
      expect(result.sharesIn).toBe(shares);

      const { functionName, args } = decodeInvocation(result.txXdr);
      expect(functionName).toBe("withdraw_capital");
      expect(args).toEqual([provider, BigInt(shares)]);
    });

    it("rejects a withdrawal that exceeds available (unlocked) pool capacity", async () => {
      const { poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository } = buildRepos();
      const service = new PoolService(buildConfig(), poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository);
      const shares = SNAPSHOT.totalShares.toString();
      expect.assertions(3);

      try {
        await service.withdraw({ provider, shares });
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const response = (err as BadRequestException).getResponse() as { error: string; available: string };
        expect(response.error).toBe("Pool capacity locked — too many active policies");
        expect(response.available).toBe((SNAPSHOT.totalUsdc - SNAPSHOT.lockedUsdc).toString());
      }
    });

    it("rejects a zero-share withdrawal", async () => {
      const { poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository } = buildRepos();
      const service = new PoolService(buildConfig(), poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository);
      expect.assertions(2);

      try {
        await service.withdraw({ provider, shares: "0" });
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const response = (err as BadRequestException).getResponse() as { error: string };
        expect(response.error).toBe("Withdrawal shares must be greater than zero");
      }
    });

    it("rejects a withdrawal while the on-chain lockup hasn't expired yet, without building a tx", async () => {
      const { poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository } = buildRepos();
      const service = new PoolService(buildConfig(), poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository);
      const futureUnlock = BigInt(Math.floor(Date.now() / 1000) + 3_600);
      jest
        .spyOn(rpc.Server.prototype, "simulateTransaction")
        .mockResolvedValue(simulateSuccess(nativeToScVal(futureUnlock, { type: "u64" })));
      const prepareSpy = jest.spyOn(rpc.Server.prototype, "prepareTransaction");
      const shares = (1_000n * 10_000_000n).toString();
      expect.assertions(3);

      try {
        await service.withdraw({ provider, shares });
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const response = (err as BadRequestException).getResponse() as { error: string; lockupExpiresAt: string };
        expect(response.lockupExpiresAt).toBe(futureUnlock.toString());
        expect(prepareSpy).not.toHaveBeenCalled();
      }
    });

    it("allows a withdrawal once the on-chain lockup has expired", async () => {
      const { poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository } = buildRepos();
      const service = new PoolService(buildConfig(), poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository);
      const pastUnlock = BigInt(Math.floor(Date.now() / 1000) - 1);
      jest
        .spyOn(rpc.Server.prototype, "simulateTransaction")
        .mockResolvedValue(simulateSuccess(nativeToScVal(pastUnlock, { type: "u64" })));
      const shares = (1_000n * 10_000_000n).toString();

      await expect(service.withdraw({ provider, shares })).resolves.not.toThrow();
    });
  });

  describe("lockupExpiresAt", () => {
    it("returns null when the contract reports no lockup (Option::None)", async () => {
      const { poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository } = buildRepos();
      const service = new PoolService(buildConfig(), poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository);
      jest.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue(simulateSuccess(xdr.ScVal.scvVoid()));

      expect(await service.lockupExpiresAt(provider)).toBeNull();
    });

    it("returns the unlock timestamp when the contract reports one", async () => {
      const { poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository } = buildRepos();
      const service = new PoolService(buildConfig(), poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository);
      const unlocksAt = 1_800_000_000n;
      jest
        .spyOn(rpc.Server.prototype, "simulateTransaction")
        .mockResolvedValue(simulateSuccess(nativeToScVal(unlocksAt, { type: "u64" })));

      expect(await service.lockupExpiresAt(provider)).toBe(unlocksAt);
    });

    it("returns null without contacting the network when the pool contract isn't configured", async () => {
      const { poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository } = buildRepos();
      const unconfigured = new PoolService(buildConfig({ poolContractId: "" }), poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository);
      const getAccountSpy = jest.spyOn(rpc.Server.prototype, "getAccount");

      expect(await unconfigured.lockupExpiresAt(provider)).toBeNull();
      expect(getAccountSpy).not.toHaveBeenCalled();
    });

    it("wraps a simulation error in a BadRequestException", async () => {
      const { poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository } = buildRepos();
      const service = new PoolService(buildConfig(), poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository);
      jest
        .spyOn(rpc.Server.prototype, "simulateTransaction")
        .mockResolvedValue({ error: "boom" } as unknown as rpc.Api.SimulateTransactionResponse);
      expect.assertions(2);

      try {
        await service.lockupExpiresAt(provider);
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const response = (err as BadRequestException).getResponse() as { error: string };
        expect(response.error).toContain("boom");
      }
    });
  });

  describe("unconfigured pool contract", () => {
    it("rejects provide/withdraw with a clear error instead of calling a non-existent contract", async () => {
      const { poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository } = buildRepos();
      const unconfigured = new PoolService(buildConfig({ poolContractId: "" }), poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository);
      const getAccountSpy = jest.spyOn(rpc.Server.prototype, "getAccount");
      expect.assertions(3);

      try {
        await unconfigured.provide({ provider, amount: "100" });
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const response = (err as BadRequestException).getResponse() as { error: string };
        expect(response.error).toContain("REFRACT_POOL_CONTRACT_ID");
        expect(getAccountSpy).not.toHaveBeenCalled();
      }
    });
  });

  describe("getPremiumHistory", () => {
    it("delegates to PremiumRevenueRepository.getDailyHistory and returns its result", async () => {
      const { poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository } = buildRepos();
      const fakeHistory = [
        { date: "2026-09-28", premiums: "12000", payouts: "0", apyBps: 820 },
        { date: "2026-09-27", premiums: "9000", payouts: "5000", apyBps: 800 },
      ];
      premiumRevenueRepository.getDailyHistory.mockResolvedValue(fakeHistory);
      const service = new PoolService(buildConfig(), poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository);

      const history = await service.getPremiumHistory();

      expect(history).toEqual(fakeHistory);
      expect(premiumRevenueRepository.getDailyHistory).toHaveBeenCalledWith(30);
    });

    it("returns an empty array when no premium data exists yet (no random fabrication)", async () => {
      const { poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository } = buildRepos();
      premiumRevenueRepository.getDailyHistory.mockResolvedValue([]);
      const service = new PoolService(buildConfig(), poolSnapshotRepository, lpPositionRepository, premiumRevenueRepository);

      const history = await service.getPremiumHistory();

      expect(history).toEqual([]);
    });
  });
});
