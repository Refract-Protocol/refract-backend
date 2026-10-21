import { OracleReading } from "./oracle-reading";
import { calculateOracleIntervalMs, MAX_ORACLE_INTERVAL_MS, MIN_ORACLE_INTERVAL_MS } from "./oracle-cadence";

function reading(overrides: Partial<OracleReading> = {}): OracleReading {
  return {
    coverageType: "StablecoinDepeg",
    type: "oracle_update",
    value: 1,
    threshold: 0.95,
    severity: "low",
    message: "test reading",
    ...overrides,
  };
}

describe("adaptive oracle polling cadence", () => {
  it("polls faster near the payout threshold than on a quiet feed", () => {
    const quiet = calculateOracleIntervalMs(reading(), undefined, 0);
    const near = calculateOracleIntervalMs(reading({ value: 0.97 }), undefined, 0);

    expect(near).toBeLessThan(quiet);
  });

  it("polls faster after a volatile move", () => {
    const stable = calculateOracleIntervalMs(reading({ value: 0.7 }), 0.71, 0);
    const volatile = calculateOracleIntervalMs(reading({ value: 0.7 }), 1, 0);

    expect(volatile).toBeLessThan(stable);
  });

  it("slows down after a quiet reading remains far from the trigger", () => {
    const quiet = calculateOracleIntervalMs(reading({ value: 1.5 }), 1.5, 0);

    expect(quiet).toBeGreaterThan(60_000);
  });

  it("slows cadence under provider quota pressure without exceeding bounds", () => {
    const normal = calculateOracleIntervalMs(reading({ value: 0.97 }), undefined, 0);
    const pressured = calculateOracleIntervalMs(reading({ value: 0.97 }), undefined, 0.75);

    expect(pressured).toBeGreaterThan(normal);
    expect(calculateOracleIntervalMs(reading(), undefined, 1)).toBeLessThanOrEqual(MAX_ORACLE_INTERVAL_MS);
    expect(calculateOracleIntervalMs(reading({ value: 0.95 }), 1, 0)).toBeGreaterThanOrEqual(MIN_ORACLE_INTERVAL_MS);
  });

  it("does not treat a degraded fallback value as being near a trigger", () => {
    const degraded = calculateOracleIntervalMs(reading({ value: 0.95, degraded: true }), undefined, 0);

    expect(degraded).toBe(60_000);
  });
});
