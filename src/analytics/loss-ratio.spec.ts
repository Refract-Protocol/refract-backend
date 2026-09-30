import { computeLossRatio } from "./loss-ratio";

const USDC = 10_000_000n; // 1e7 fixed-point

describe("computeLossRatio", () => {
  it("computes per-type and overall ratios against hand-computed fixtures", () => {
    const report = computeLossRatio([
      // 1,000 premium / 250 paid -> 25.00%
      { coverageType: "stablecoin_depeg", premiumCollected: 1_000n * USDC, claimsPaid: 250n * USDC },
      // 400 premium / 600 paid -> 150.00% (underpriced)
      { coverageType: "market_crash", premiumCollected: 400n * USDC, claimsPaid: 600n * USDC },
      // 3 premium / 1 paid -> 33.33% (rounded down from 3333.33 bps)
      { coverageType: "flight_delay", premiumCollected: 3n * USDC, claimsPaid: 1n * USDC },
    ]);

    expect(report.byCoverageType).toEqual([
      { coverageType: "flight_delay", premiumCollected: "30000000", claimsPaid: "10000000", lossRatioBps: 3333 },
      { coverageType: "market_crash", premiumCollected: "4000000000", claimsPaid: "6000000000", lossRatioBps: 15000 },
      { coverageType: "stablecoin_depeg", premiumCollected: "10000000000", claimsPaid: "2500000000", lossRatioBps: 2500 },
    ]);
    // 1,403 premium / 851 paid -> 6065.57 bps -> 6065
    expect(report.overall).toEqual({ premiumCollected: "14030000000", claimsPaid: "8510000000", lossRatioBps: 6065 });
  });

  it("reports 0 bps when premium was collected but nothing was paid", () => {
    const report = computeLossRatio([
      { coverageType: "liquidation_shield", premiumCollected: 500n * USDC, claimsPaid: 0n },
    ]);

    expect(report.byCoverageType[0].lossRatioBps).toBe(0);
    expect(report.overall.lossRatioBps).toBe(0);
  });

  it("reports a null ratio instead of dividing by zero when no premium was collected", () => {
    const report = computeLossRatio([
      { coverageType: "smart_contract_risk", premiumCollected: 0n, claimsPaid: 100n * USDC },
      { coverageType: "flight_delay", premiumCollected: 0n, claimsPaid: 0n },
    ]);

    expect(report.byCoverageType.map((l) => l.lossRatioBps)).toEqual([null, null]);
    expect(report.overall).toEqual({ premiumCollected: "0", claimsPaid: "1000000000", lossRatioBps: null });
  });

  it("returns an empty breakdown and a null overall ratio for an empty window", () => {
    expect(computeLossRatio([])).toEqual({
      overall: { premiumCollected: "0", claimsPaid: "0", lossRatioBps: null },
      byCoverageType: [],
    });
  });

  it("sums separate premium and claims rows for the same coverage type", () => {
    const report = computeLossRatio([
      { coverageType: "market_crash", premiumCollected: 200n * USDC, claimsPaid: 0n },
      { coverageType: "market_crash", premiumCollected: 0n, claimsPaid: 50n * USDC },
    ]);

    expect(report.byCoverageType).toEqual([
      { coverageType: "market_crash", premiumCollected: "2000000000", claimsPaid: "500000000", lossRatioBps: 2500 },
    ]);
  });

  it("keeps full precision on amounts beyond Number.MAX_SAFE_INTEGER", () => {
    const huge = 10n ** 29n; // fits NUMERIC(30, 0)
    const report = computeLossRatio([{ coverageType: "stablecoin_depeg", premiumCollected: huge, claimsPaid: huge / 4n }]);

    expect(report.overall.premiumCollected).toBe(huge.toString());
    expect(report.overall.lossRatioBps).toBe(2500);
  });

  it("rejects negative aggregates", () => {
    expect(() =>
      computeLossRatio([{ coverageType: "flight_delay", premiumCollected: -1n, claimsPaid: 0n }])
    ).toThrow(RangeError);
  });
});
