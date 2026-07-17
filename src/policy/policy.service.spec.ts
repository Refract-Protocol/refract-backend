import { PolicyService } from "./policy.service";
import { BuyPolicyDto } from "./dto/buy-policy.dto";

const HOLDER = "GHOLDER0000000000000000000000000000000000000000000000";

function buildDto(overrides: Partial<BuyPolicyDto> = {}): BuyPolicyDto {
  return {
    holder: HOLDER,
    coverageType: 0,
    coverageAmount: "1000000000000", // 100,000 USDC in 1e7 base units
    durationDays: 365,
    ...overrides,
  };
}

describe("PolicyService", () => {
  let service: PolicyService;

  beforeEach(() => {
    service = new PolicyService();
  });

  describe("buy", () => {
    // Regression coverage for a pricing bug: the premium formula skipped
    // converting BASE_RATE_BPS from basis points to a fraction (missing
    // /10_000), so a policy was charged ~100x its listed annual rate. These
    // pin premium to the catalog's advertised baseRatePct per coverageType.
    it.each([
      [0, 3.0],
      [1, 4.5],
      [2, 6.0],
      [3, 9.0],
      [4, 2.4],
    ])("charges the catalog's annual base rate for coverageType %d over a 365-day policy", (coverageType, baseRatePct) => {
      const coverageAmount = "1000000000000";

      const { policy } = service.buy(buildDto({ coverageType, coverageAmount, durationDays: 365 }));

      const expectedPremium = BigInt(Math.floor(Number(BigInt(coverageAmount)) * (baseRatePct / 100)));
      const actualPremium = BigInt(policy.premium);
      const diff = actualPremium > expectedPremium ? actualPremium - expectedPremium : expectedPremium - actualPremium;
      expect(diff).toBeLessThanOrEqual(1n); // day-count/floor rounding only
    });

    it("prorates the premium by duration", () => {
      const coverageAmount = "1000000000000";

      const { policy: yearPolicy } = service.buy(buildDto({ coverageAmount, durationDays: 365 }));
      const { policy: monthPolicy } = service.buy(buildDto({ coverageAmount, durationDays: 30 }));

      const yearPremium = BigInt(yearPolicy.premium);
      const monthPremium = BigInt(monthPolicy.premium);
      const expectedMonthPremium = (yearPremium * 30n) / 365n;
      const diff =
        monthPremium > expectedMonthPremium ? monthPremium - expectedMonthPremium : expectedMonthPremium - monthPremium;
      expect(diff).toBeLessThanOrEqual(1n);
    });

    it("stores an active policy with the expected fields and an unsigned tx stub", () => {
      const dto = buildDto({ coverageType: 2, durationDays: 10 });
      const beforeSeconds = Math.floor(Date.now() / 1000);

      const { policy, txXdr, message } = service.buy(dto);

      expect(policy.holder).toBe(HOLDER);
      expect(policy.coverageType).toBe(2);
      expect(policy.coverageTypeName).toBe("Liquidation Shield");
      expect(policy.coverageAmount).toBe(dto.coverageAmount);
      expect(policy.durationDays).toBe(10);
      expect(policy.isActive).toBe(true);
      expect(policy.expiresAt).toBeGreaterThanOrEqual(beforeSeconds + 10 * 86_400);
      expect(txXdr).toBe("// TODO: Soroban invoke XDR");
      expect(message).toBe("Sign and submit to activate coverage");
    });
  });

  describe("lookups and lifecycle", () => {
    it("findById/findByHolder return a bought policy, and listActive drops it once deactivated", () => {
      const { policy } = service.buy(buildDto());

      expect(service.findById(policy.id)).toEqual(policy);
      expect(service.findByHolder(HOLDER)).toEqual([policy]);
      expect(service.listActive().map((p) => p.id)).toContain(policy.id);

      service.deactivate(policy.id);

      expect(service.findById(policy.id)?.isActive).toBe(false);
      expect(service.listActive().map((p) => p.id)).not.toContain(policy.id);
    });

    it("findById returns undefined for an unknown id", () => {
      expect(service.findById("does-not-exist")).toBeUndefined();
    });

    it("deactivate is a no-op for an unknown id", () => {
      expect(() => service.deactivate("does-not-exist")).not.toThrow();
    });
  });

  describe("listTypes", () => {
    it("returns all five coverage types", () => {
      expect(service.listTypes()).toHaveLength(5);
    });
  });
});
