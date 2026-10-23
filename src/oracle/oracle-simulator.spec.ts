import {
  HistoricalOracleObservation,
  simulateOracleParameters,
} from "./oracle-simulator";

const candidate = {
  schemaVersion: 1,
  quorum: 2,
  freshnessSeconds: 10,
  anomalyDeviationPct: 10,
  thresholds: {},
};

function observation(
  coverageType: HistoricalOracleObservation["coverageType"],
  value: number,
  source: string,
  second: number,
  severity = "low",
): HistoricalOracleObservation {
  return {
    coverageType,
    value,
    source,
    severity,
    recordedAt: new Date(second * 1_000),
  };
}

const window = { from: new Date(0), to: new Date(20_000) };

describe("offline oracle parameter simulation", () => {
  it("compares historical decisions and estimates payout changes from settled history", () => {
    const readings = [
      observation("StablecoinDepeg", 0.9, "CoinGecko", 1, "triggered"),
      observation("StablecoinDepeg", 0.91, "SecondOracle", 1),
      observation("StablecoinDepeg", 0.98, "CoinGecko", 3),
      observation("StablecoinDepeg", 0.99, "SecondOracle", 3),
    ];

    const result = simulateOracleParameters(
      readings,
      { StablecoinDepeg: { settledClaims: 2, payoutTotal: "200" } },
      { ...candidate, thresholds: { StablecoinDepeg: 0.99 } },
      window,
    );

    expect(result.readingsProcessed).toBe(4);
    expect(result.coverageTypes.StablecoinDepeg).toMatchObject({
      baselineTriggers: 1,
      candidateTriggers: 2,
      changedToTrigger: 1,
      changedToNoTrigger: 0,
      estimatedBaselinePayout: "100.0000000",
      estimatedCandidatePayout: "200.0000000",
      estimatedPayoutDelta: "100.0000000",
    });
    expect(result.estimatedPayoutDelta).toBe("100.0000000");
    expect(result.payoutEstimateNote).toContain("indicative");
  });

  it("requires distinct fresh sources to meet the candidate quorum", () => {
    const result = simulateOracleParameters(
      [
        observation("MarketCrash", -40, "CoinGecko", 1, "triggered"),
        observation("MarketCrash", -40, "SecondOracle", 8),
      ],
      {},
      { ...candidate, freshnessSeconds: 2 },
      window,
    );

    expect(result.coverageTypes.MarketCrash.candidateTriggers).toBe(0);
    expect(result.coverageTypes.MarketCrash.quorumRejected).toBe(2);
  });

  it("filters anomalous source values before calculating quorum consensus", () => {
    const result = simulateOracleParameters(
      [
        observation("StablecoinDepeg", 0.9, "A", 1),
        observation("StablecoinDepeg", 0.91, "B", 1),
        observation("StablecoinDepeg", 10, "Outlier", 1),
      ],
      {},
      candidate,
      window,
    );

    expect(result.coverageTypes.StablecoinDepeg.anomalyFiltered).toBe(1);
    expect(result.coverageTypes.StablecoinDepeg.candidateTriggers).toBe(1);
  });

  it("uses a strict greater-than trigger for FlightDelay", () => {
    const result = simulateOracleParameters(
      [
        observation("FlightDelay", 120, "A", 1),
        observation("FlightDelay", 120, "B", 1),
        observation("FlightDelay", 121, "A", 2),
        observation("FlightDelay", 121, "B", 2),
      ],
      {},
      candidate,
      window,
    );

    expect(result.coverageTypes.FlightDelay.candidateTriggers).toBe(1);
  });

  it("rejects invalid candidates and invalid time windows", () => {
    expect(() =>
      simulateOracleParameters([], {}, { ...candidate, quorum: 0 }, window),
    ).toThrow();
    expect(() =>
      simulateOracleParameters([], {}, candidate, { from: new Date(10), to: new Date(0) }),
    ).toThrow(/from before to/);
  });
});
