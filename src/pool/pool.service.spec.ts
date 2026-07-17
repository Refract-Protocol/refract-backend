import { BadRequestException } from "@nestjs/common";
import { PoolService } from "./pool.service";

// Mirrors the module-private `mockPool` constants in pool.service.ts.
const MOCK_POOL = {
  totalUsdc: BigInt(18_400_000 * 1e7),
  totalShares: BigInt(17_800_000 * 1e7),
  lockedUsdc: BigInt(2_900_000 * 1e7),
  premiumAccrued: BigInt(284_000 * 1e7),
  utilizationBps: 1576,
  apyBps: 890,
  sharePrice: 1.0319,
};

describe("PoolService", () => {
  let service: PoolService;

  beforeEach(() => {
    service = new PoolService();
  });

  describe("getStats", () => {
    it("derives availableUsdc from totalUsdc minus lockedUsdc and echoes the rest of the mock pool state", () => {
      const stats = service.getStats();

      expect(stats.totalUsdc).toBe(MOCK_POOL.totalUsdc.toString());
      expect(stats.totalShares).toBe(MOCK_POOL.totalShares.toString());
      expect(stats.lockedUsdc).toBe(MOCK_POOL.lockedUsdc.toString());
      expect(stats.premiumAccrued).toBe(MOCK_POOL.premiumAccrued.toString());
      expect(stats.availableUsdc).toBe((MOCK_POOL.totalUsdc - MOCK_POOL.lockedUsdc).toString());
      expect(stats.utilizationBps).toBe(MOCK_POOL.utilizationBps);
      expect(stats.apyBps).toBe(MOCK_POOL.apyBps);
      expect(stats.sharePrice).toBe(MOCK_POOL.sharePrice);
      expect(stats.maxUtilizationBps).toBe(8000);
    });
  });

  describe("getUserPosition", () => {
    it("computes usdcValue, premiumEarned, and pct from the fixed mock share balance", () => {
      const address = "GPROVIDER0000000000000000000000000000000000000000000";

      const position = service.getUserPosition(address);

      const mockShares = BigInt(Math.floor(30_000 * 1e7));
      const expectedUsdcValue = Number(mockShares) * MOCK_POOL.sharePrice;

      expect(position.address).toBe(address);
      expect(position.shares).toBe(mockShares.toString());
      expect(position.usdcValue).toBe(expectedUsdcValue.toFixed(0));
      expect(position.premiumEarned).toBe((expectedUsdcValue * 0.089 * 0.5).toFixed(0));
      expect(position.pct).toBe(((Number(mockShares) / Number(MOCK_POOL.totalShares)) * 100).toFixed(4));
    });
  });

  describe("provide", () => {
    it("computes sharesOut proportionally to the current share price and returns an unsigned tx stub", () => {
      const amount = (184_000n * 10_000_000n).toString(); // 184,000 USDC in 1e7 base units

      const result = service.provide({ provider: "GPROVIDER", amount });

      const expectedShares = (BigInt(amount) * MOCK_POOL.totalShares) / MOCK_POOL.totalUsdc;
      expect(result.sharesOut).toBe(expectedShares.toString());
      expect(result.amountUsdc).toBe(amount);
      expect(result.sharePrice).toBe(MOCK_POOL.sharePrice);
      expect(result.txXdr).toBe("// TODO: Soroban invoke XDR");
    });
  });

  describe("withdraw", () => {
    it("computes usdcOut proportionally and returns an unsigned tx stub when within available capacity", () => {
      const shares = (1_000_000n * 10_000_000n).toString(); // 1,000,000 shares

      const result = service.withdraw({ provider: "GPROVIDER", shares });

      const expectedUsdcOut = (BigInt(shares) * MOCK_POOL.totalUsdc) / MOCK_POOL.totalShares;
      expect(result.usdcOut).toBe(expectedUsdcOut.toString());
      expect(result.sharesIn).toBe(shares);
      expect(result.txXdr).toBe("// TODO: Soroban invoke XDR");
    });

    it("rejects a withdrawal that exceeds available (unlocked) pool capacity", () => {
      // Requesting all shares would out-pace the unlocked USDC, since
      // lockedUsdc covers active policies and isn't withdrawable.
      const shares = MOCK_POOL.totalShares.toString();
      expect.assertions(3);

      try {
        service.withdraw({ provider: "GPROVIDER", shares });
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const response = (err as BadRequestException).getResponse() as { error: string; available: string };
        expect(response.error).toBe("Pool capacity locked — too many active policies");
        expect(response.available).toBe((MOCK_POOL.totalUsdc - MOCK_POOL.lockedUsdc).toString());
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
