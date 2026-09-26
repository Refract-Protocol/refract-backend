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
import { PoolService, SHARE_PRICE_SCALE } from "./pool.service";

/** Canonical live pool snapshot used by most tests (1e7 fixed-point). */
const LIVE_POOL = {
  totalUsdc: 184_000_000_000_000n, // 18_400_000 * 1e7
  totalShares: 178_000_000_000_000n,
  lockedUsdc: 29_000_000_000_000n,
  premiumAccrued: 2_840_000_000_000n,
};

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const POOL_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));
const DEFAULT_LEDGER = 42_000;

function buildConfig(overrides: Partial<AppConfig["stellar"]> = {}): ConfigService<AppConfig, true> {
  const stellar: AppConfig["stellar"] = {
    network: "testnet",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: NETWORK_PASSPHRASE,
    poolContractId: POOL_CONTRACT_ID,
    policyContractId: "",
    oracleContractId: "",
    relayerSecret: "",
    validateOnChain: false,
    requireNetwork: false,
    validateTimeoutMs: 5_000,
    relayer: {
      feeMultiplier: 1.2,
      feeCeiling: 1_000_000,
      idleResyncMs: 30_000,
      minBalance: 50_000_000,
      maxAttempts: 3,
    },
    eventIndexer: {
      enabled: false,
      pollIntervalMs: 5_000,
      lagAlertLedgers: 100,
      pageLimit: 100,
    },
    ...overrides,
  };
  return { get: jest.fn().mockReturnValue(stellar) } as unknown as ConfigService<AppConfig, true>;
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

function functionNameFromTx(tx: unknown): string {
  const built = tx as Transaction;
  const op = built.operations[0] as Extract<Transaction["operations"][number], { type: "invokeHostFunction" }>;
  return op.func.invokeContract().functionName().toString();
}

/** A minimal simulateTransaction success response carrying a return value + ledger. */
function simulateSuccess(retval: xdr.ScVal, latestLedger = DEFAULT_LEDGER): rpc.Api.SimulateTransactionResponse {
  return { result: { retval, auth: [] }, latestLedger } as unknown as rpc.Api.SimulateTransactionResponse;
}

function i128(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "i128" });
}

/**
 * Dispatches simulateTransaction by invoked contract method so lockup reads
 * and the four pool views can share one spy without call-order races.
 */
function mockPoolViews(
  overrides: Partial<typeof LIVE_POOL> & { lockup?: xdr.ScVal; ledger?: number } = {},
) {
  const pool = { ...LIVE_POOL, ...overrides };
  const ledger = overrides.ledger ?? DEFAULT_LEDGER;
  const lockupRet = overrides.lockup ?? xdr.ScVal.scvVoid();

  return jest.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(async (tx) => {
    const name = functionNameFromTx(tx);
    switch (name) {
      case "total_usdc":
        return simulateSuccess(i128(pool.totalUsdc), ledger);
      case "total_shares":
        return simulateSuccess(i128(pool.totalShares), ledger);
      case "locked_usdc":
        return simulateSuccess(i128(pool.lockedUsdc), ledger);
      case "premium_accrued":
        return simulateSuccess(i128(pool.premiumAccrued), ledger);
      case "lockup_expires_at":
        return simulateSuccess(lockupRet, ledger);
      default:
        return simulateSuccess(xdr.ScVal.scvVoid(), ledger);
    }
  });
}

describe("PoolService", () => {
  let service: PoolService;
  let provider: string;

  beforeEach(() => {
    service = new PoolService(buildConfig());
    provider = Keypair.random().publicKey();
    // prepareTransaction normally simulates against a live network and
    // fills in Soroban resource fees — that's SDK behavior, not this
    // service's logic, so it's short-circuited to identity here (same
    // approach as ClaimSettlementService's tests).
    jest.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(async (id: string) => new Account(id, "1"));
    jest.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) => tx as never);
    mockPoolViews();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("getStats", () => {
    it("serves live values from simulated pool views with fixed-point share price", async () => {
      const stats = await service.getStats();

      expect(stats).toEqual({
        available: true,
        totalUsdc: LIVE_POOL.totalUsdc.toString(),
        totalShares: LIVE_POOL.totalShares.toString(),
        lockedUsdc: LIVE_POOL.lockedUsdc.toString(),
        premiumAccrued: LIVE_POOL.premiumAccrued.toString(),
        availableUsdc: (LIVE_POOL.totalUsdc - LIVE_POOL.lockedUsdc).toString(),
        utilizationBps: Number((LIVE_POOL.lockedUsdc * 10_000n) / LIVE_POOL.totalUsdc),
        apyBps: 0,
        sharePriceE7: ((LIVE_POOL.totalUsdc * SHARE_PRICE_SCALE) / LIVE_POOL.totalShares).toString(),
        maxUtilizationBps: 8000,
        ledger: DEFAULT_LEDGER,
        readAt: expect.any(String),
      });
      if (stats.available) {
        expect(Number.isNaN(Date.parse(stats.readAt))).toBe(false);
      }
    });

    it("returns utilizationBps 0 and 1.0 share price when the pool is empty (no div-by-zero)", async () => {
      mockPoolViews({ totalUsdc: 0n, totalShares: 0n, lockedUsdc: 0n, premiumAccrued: 0n });

      const stats = await service.getStats();

      expect(stats).toMatchObject({
        available: true,
        totalUsdc: "0",
        totalShares: "0",
        utilizationBps: 0,
        sharePriceE7: SHARE_PRICE_SCALE.toString(),
        availableUsdc: "0",
      });
    });

    it("returns unavailable when the pool contract isn't configured (no fabricated numbers)", async () => {
      const unconfigured = new PoolService(buildConfig({ poolContractId: "" }));
      const simSpy = jest.spyOn(rpc.Server.prototype, "simulateTransaction");

      const stats = await unconfigured.getStats();

      expect(stats).toEqual({
        available: false,
        reason: expect.stringContaining("REFRACT_POOL_CONTRACT_ID"),
      });
      expect(simSpy).not.toHaveBeenCalled();
    });

    it("surfaces a simulation error as BadRequestException", async () => {
      jest
        .spyOn(rpc.Server.prototype, "simulateTransaction")
        .mockResolvedValue({ error: "boom" } as unknown as rpc.Api.SimulateTransactionResponse);
      expect.assertions(2);

      try {
        await service.getStats();
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const response = (err as BadRequestException).getResponse() as { error: string };
        expect(response.error).toContain("boom");
      }
    });

    it("round-trips BigInt amounts larger than Number.MAX_SAFE_INTEGER exactly", async () => {
      const huge = (1n << 60n) + 12345n; // > 2^53
      mockPoolViews({
        totalUsdc: huge,
        totalShares: huge,
        lockedUsdc: 0n,
        premiumAccrued: huge,
      });

      const stats = await service.getStats();

      expect(stats.available).toBe(true);
      if (stats.available) {
        expect(stats.totalUsdc).toBe(huge.toString());
        expect(stats.totalShares).toBe(huge.toString());
        expect(stats.premiumAccrued).toBe(huge.toString());
        expect(stats.sharePriceE7).toBe(SHARE_PRICE_SCALE.toString()); // 1:1
        expect(BigInt(stats.totalUsdc)).toBe(huge);
      }
    });

    it("dedupes concurrent getStats via single-flight (one RPC fan-out)", async () => {
      const simSpy = mockPoolViews();

      const [a, b, c] = await Promise.all([service.getStats(), service.getStats(), service.getStats()]);

      // Four view methods, once — not 4 × 3 concurrent fans.
      expect(simSpy).toHaveBeenCalledTimes(4);
      expect(a).toEqual(b);
      expect(b).toEqual(c);
    });
  });

  describe("getUserPosition", () => {
    it("marks the position unavailable rather than fabricating mock shares", async () => {
      const position = await service.getUserPosition(provider);

      expect(position).toEqual({
        available: false,
        reason: expect.stringContaining("not available"),
      });
    });

    it("returns unavailable when the pool contract isn't configured", async () => {
      const unconfigured = new PoolService(buildConfig({ poolContractId: "" }));

      const position = await unconfigured.getUserPosition(provider);

      expect(position).toEqual({
        available: false,
        reason: expect.stringContaining("REFRACT_POOL_CONTRACT_ID"),
      });
    });
  });

  describe("provide", () => {
    it("computes sharesOut from live state and returns unsigned provide_capital plus read metadata", async () => {
      const amount = (184_000n * 10_000_000n).toString(); // 184,000 USDC in 1e7 base units

      const result = await service.provide({ provider, amount });

      const expectedShares = (BigInt(amount) * LIVE_POOL.totalShares) / LIVE_POOL.totalUsdc;
      expect(result.sharesOut).toBe(expectedShares.toString());
      expect(result.amountUsdc).toBe(amount);
      expect(result.sharePriceE7).toBe(
        ((LIVE_POOL.totalUsdc * SHARE_PRICE_SCALE) / LIVE_POOL.totalShares).toString(),
      );
      expect(result.ledger).toBe(DEFAULT_LEDGER);
      expect(typeof result.readAt).toBe("string");

      const { functionName, args } = decodeInvocation(result.txXdr);
      expect(functionName).toBe("provide_capital");
      expect(args).toEqual([provider, BigInt(amount)]);
    });

    it("mints shares 1:1 on the first deposit into an empty pool", async () => {
      mockPoolViews({ totalUsdc: 0n, totalShares: 0n, lockedUsdc: 0n, premiumAccrued: 0n });
      const amount = "10000000000";

      const result = await service.provide({ provider, amount });

      expect(result.sharesOut).toBe(amount);
      expect(result.sharePriceE7).toBe(SHARE_PRICE_SCALE.toString());
    });

    it("rejects a zero-amount deposit without contacting the network", async () => {
      const getAccountSpy = jest.spyOn(rpc.Server.prototype, "getAccount");
      const simSpy = jest.spyOn(rpc.Server.prototype, "simulateTransaction");
      simSpy.mockClear();
      expect.assertions(4);
      try {
        await service.provide({ provider, amount: "0" });
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const response = (err as BadRequestException).getResponse() as { error: string };
        expect(response.error).toBe("Deposit amount must be greater than zero");
        expect(getAccountSpy).not.toHaveBeenCalled();
        expect(simSpy).not.toHaveBeenCalled();
      }
    });

    it("wraps a Soroban build failure (e.g. simulation rejection) in a BadRequestException", async () => {
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
    it("computes usdcOut from live state and returns unsigned withdraw_capital plus read metadata", async () => {
      const shares = (1_000_000n * 10_000_000n).toString(); // 1,000,000 shares

      const result = await service.withdraw({ provider, shares });

      const expectedUsdcOut = (BigInt(shares) * LIVE_POOL.totalUsdc) / LIVE_POOL.totalShares;
      expect(result.usdcOut).toBe(expectedUsdcOut.toString());
      expect(result.sharesIn).toBe(shares);
      expect(result.sharePriceE7).toBe(
        ((LIVE_POOL.totalUsdc * SHARE_PRICE_SCALE) / LIVE_POOL.totalShares).toString(),
      );
      expect(result.ledger).toBe(DEFAULT_LEDGER);
      expect(typeof result.readAt).toBe("string");

      const { functionName, args } = decodeInvocation(result.txXdr);
      expect(functionName).toBe("withdraw_capital");
      expect(args).toEqual([provider, BigInt(shares)]);
    });

    it("rejects a withdrawal that exceeds available (unlocked) pool capacity", async () => {
      const shares = LIVE_POOL.totalShares.toString();
      expect.assertions(3);

      try {
        await service.withdraw({ provider, shares });
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const response = (err as BadRequestException).getResponse() as { error: string; available: string };
        expect(response.error).toBe("Pool capacity locked — too many active policies");
        expect(response.available).toBe((LIVE_POOL.totalUsdc - LIVE_POOL.lockedUsdc).toString());
      }
    });

    it("rejects withdraw when the pool has zero shares outstanding (no div-by-zero)", async () => {
      mockPoolViews({ totalUsdc: 0n, totalShares: 0n, lockedUsdc: 0n, premiumAccrued: 0n });
      expect.assertions(2);

      try {
        await service.withdraw({ provider, shares: "100" });
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const response = (err as BadRequestException).getResponse() as { error: string };
        expect(response.error).toMatch(/zero shares/i);
      }
    });

    it("rejects a zero-share withdrawal", async () => {
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
      const futureUnlock = BigInt(Math.floor(Date.now() / 1000) + 3_600);
      mockPoolViews({ lockup: nativeToScVal(futureUnlock, { type: "u64" }) });
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
      const pastUnlock = BigInt(Math.floor(Date.now() / 1000) - 1);
      mockPoolViews({ lockup: nativeToScVal(pastUnlock, { type: "u64" }) });
      const shares = (1_000n * 10_000_000n).toString();

      await expect(service.withdraw({ provider, shares })).resolves.not.toThrow();
    });
  });

  describe("lockupExpiresAt", () => {
    it("returns null when the contract reports no lockup (Option::None)", async () => {
      mockPoolViews({ lockup: xdr.ScVal.scvVoid() });

      expect(await service.lockupExpiresAt(provider)).toBeNull();
    });

    it("returns the unlock timestamp when the contract reports one", async () => {
      const unlocksAt = 1_800_000_000n;
      mockPoolViews({ lockup: nativeToScVal(unlocksAt, { type: "u64" }) });

      expect(await service.lockupExpiresAt(provider)).toBe(unlocksAt);
    });

    it("returns null without contacting the network when the pool contract isn't configured", async () => {
      const unconfigured = new PoolService(buildConfig({ poolContractId: "" }));
      const getAccountSpy = jest.spyOn(rpc.Server.prototype, "getAccount");

      expect(await unconfigured.lockupExpiresAt(provider)).toBeNull();
      expect(getAccountSpy).not.toHaveBeenCalled();
    });

    it("wraps a simulation error in a BadRequestException", async () => {
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
      const unconfigured = new PoolService(buildConfig({ poolContractId: "" }));
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
    afterEach(() => {
      jest.spyOn(Math, "random").mockRestore();
    });

    it("returns 30 days of history in descending date order starting today", () => {
      jest.spyOn(Math, "random").mockReturnValue(0.5); // 0.5 < 0.9, so payouts stay "0" every day

      const history = service.getPremiumHistory();

      expect(history).toHaveLength(30);
      expect(history[0].date).toBe(new Date().toISOString().split("T")[0]);
      expect(history[0].payouts).toBe("0");
      expect(history[0].premiums).toBe((4_000 + 0.5 * 12_000).toFixed(0));
      expect(history[0].apyBps).toBe(Math.floor(700 + 0.5 * 400));

      const day0 = new Date(history[0].date);
      const day1 = new Date(history[1].date);
      expect((day0.getTime() - day1.getTime()) / 86_400_000).toBe(1);
    });

    it("includes a non-zero payout for a day when the random draw clears the 0.9 threshold", () => {
      jest.spyOn(Math, "random").mockReturnValue(0.95);

      const history = service.getPremiumHistory();

      expect(history[0].payouts).toBe((5_000 + 0.95 * 30_000).toFixed(0));
    });
  });
});
