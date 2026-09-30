import { COVERAGE_TYPES, coverageTypeById, coverageTypeByName } from "./coverage-types";
import { CoverageTypeName } from "../quote/coverage-type";
import { PolicyService } from "../policy/policy.service";
import { QuoteService } from "../quote/quote.service";

describe("coverage-types catalog", () => {
  it("has exactly one entry per CoverageTypeName", () => {
    const keys = COVERAGE_TYPES.map((t) => t.key).sort();
    expect(keys).toEqual(Object.values(CoverageTypeName).sort());
  });

  it("is index-aligned with the on-chain discriminant (COVERAGE_TYPES[i].id === i)", () => {
    COVERAGE_TYPES.forEach((t, i) => expect(t.id).toBe(i));
  });

  it("maps numeric ids to the on-chain CoverageType variant order", () => {
    // refract-contracts/pool/src/lib.rs declaration order; buy-policy.dto.ts
    // validates `coverageType` as 0-4 against it.
    expect(COVERAGE_TYPES.map((t) => t.key)).toEqual([
      CoverageTypeName.StablecoinDepeg,
      CoverageTypeName.MarketCrash,
      CoverageTypeName.LiquidationShield,
      CoverageTypeName.SmartContractRisk,
      CoverageTypeName.FlightDelay,
    ]);
  });

  it("resolves the same entry by id and by name", () => {
    for (const entry of COVERAGE_TYPES) {
      expect(coverageTypeById(entry.id)).toBe(entry);
      expect(coverageTypeByName(entry.key)).toBe(entry);
    }
  });

  it("returns undefined for unknown ids and names", () => {
    expect(coverageTypeById(5)).toBeUndefined();
    expect(coverageTypeById(-1)).toBeUndefined();
    expect(coverageTypeByName("Nope" as CoverageTypeName)).toBeUndefined();
  });

  it("is the source of both services' coverage listings", () => {
    const config = {
      get: () => ({ sorobanRpcUrl: "https://soroban-testnet.stellar.org", networkPassphrase: "", poolContractId: "" }),
    } as unknown as ConstructorParameters<typeof PolicyService>[0];
    const policyTypes = new PolicyService(config).listTypes();
    const quoteTypes = new QuoteService().listCoverageTypes();

    for (const entry of COVERAGE_TYPES) {
      const policyEntry = policyTypes.find((t) => t.id === entry.id);
      const quoteEntry = quoteTypes.find((t) => t.id === entry.key);
      expect(policyEntry?.name).toBe(entry.name);
      expect(quoteEntry?.name).toBe(entry.name);
      expect(policyEntry?.riskMultiplier).toBe(quoteEntry?.riskMultiplier);
      expect(quoteEntry?.maxDuration).toBe(entry.maxDuration);
    }
  });
});
