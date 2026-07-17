import axios from "axios";
import { ConfigService } from "@nestjs/config";
import { OracleService } from "./oracle.service";
import { AppConfig } from "../config/configuration";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

const oraclesConfig: AppConfig["oracles"] = {
  coingeckoBaseUrl: "https://coingecko.test",
  horizonUrl: "https://horizon.test",
  defiLlamaBaseUrl: "https://defillama.test",
  defiLlamaProtocolSlug: "aave",
  httpTimeoutMs: 5000,
};

function buildService(): OracleService {
  const configService = {
    get: jest.fn().mockReturnValue(oraclesConfig),
  } as unknown as ConfigService<AppConfig, true>;
  return new OracleService(configService);
}

describe("OracleService", () => {
  let service: OracleService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = buildService();
  });

  describe("checkStablecoinDepeg", () => {
    it("reports a low-severity reading when USDC is at peg", async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { "usd-coin": { usd: 1.0 } } });

      const reading = await service.checkStablecoinDepeg();

      expect(reading.coverageType).toBe("StablecoinDepeg");
      expect(reading.value).toBe(1.0);
      expect(reading.threshold).toBe(0.95);
      expect(reading.severity).toBe("low");
      expect(reading.message).toContain("[CoinGecko]");
    });

    it.each([
      [0.985, "medium"],
      [0.975, "high"],
      [0.9, "triggered"],
    ])("classifies a $%s USDC price as %s severity", async (usdcPrice, expectedSeverity) => {
      mockedAxios.get.mockResolvedValueOnce({ data: { "usd-coin": { usd: usdcPrice } } });

      const reading = await service.checkStablecoinDepeg();

      expect(reading.severity).toBe(expectedSeverity);
    });

    it("degrades to a non-triggering low reading when CoinGecko errors", async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error("network down"));

      const reading = await service.checkStablecoinDepeg();

      expect(reading.coverageType).toBe("StablecoinDepeg");
      expect(reading.severity).toBe("low");
      expect(reading.value).toBe(reading.threshold);
      expect(reading.message).toContain("degraded");
    });
  });

  describe("checkMarketCrash", () => {
    it("attaches Horizon ledger context when the testnet call succeeds", async () => {
      mockedAxios.get
        .mockResolvedValueOnce({ data: { stellar: { usd: 0.1, usd_24h_change: -5 } } })
        .mockResolvedValueOnce({
          data: { _embedded: { records: [{ sequence: 12345, closed_at: "2026-07-17T00:00:00Z" }] } },
        });

      const reading = await service.checkMarketCrash();

      expect(reading.coverageType).toBe("MarketCrash");
      expect(reading.value).toBe(-5);
      expect(reading.severity).toBe("low");
      expect(reading.message).toContain("Horizon testnet ledger #12345");
    });

    it("still succeeds off CoinGecko alone when Horizon is unreachable", async () => {
      mockedAxios.get
        .mockResolvedValueOnce({ data: { stellar: { usd: 0.1, usd_24h_change: -25 } } })
        .mockRejectedValueOnce(new Error("horizon timeout"));

      const reading = await service.checkMarketCrash();

      expect(reading.severity).toBe("high");
      expect(reading.message).toContain("[CoinGecko]");
      expect(reading.message).not.toContain("Horizon testnet ledger");
    });

    it.each([
      [-5, "low"],
      [-15, "medium"],
      [-25, "high"],
      [-35, "triggered"],
    ])("classifies a %s%% 24h change as %s severity", async (change24h, expectedSeverity) => {
      mockedAxios.get
        .mockResolvedValueOnce({ data: { stellar: { usd: 0.1, usd_24h_change: change24h } } })
        .mockResolvedValueOnce({ data: { _embedded: { records: [] } } });

      const reading = await service.checkMarketCrash();

      expect(reading.severity).toBe(expectedSeverity);
    });

    it("degrades to a non-triggering low reading when the CoinGecko price call errors", async () => {
      mockedAxios.get
        .mockRejectedValueOnce(new Error("coingecko down"))
        .mockResolvedValueOnce({ data: { _embedded: { records: [] } } });

      const reading = await service.checkMarketCrash();

      expect(reading.coverageType).toBe("MarketCrash");
      expect(reading.severity).toBe("low");
      expect(reading.value).toBe(reading.threshold);
      expect(reading.message).toContain("degraded");
    });
  });

  describe("checkSmartContractRisk", () => {
    const now = 1_800_000_000;
    const dayAgo = now - 86_400 - 100; // just past the 24h cutoff so it's picked as the reference point

    it.each([
      [1_000_000, 1_000_000, "low"],
      [1_000_000, 850_000, "medium"],
      [1_000_000, 700_000, "high"],
      [1_000_000, 300_000, "triggered"],
    ])("classifies a TVL move from %d to %d as %s severity", async (referenceTvl, latestTvl, expectedSeverity) => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          name: "Aave",
          tvl: [
            { date: dayAgo, totalLiquidityUSD: referenceTvl },
            { date: now, totalLiquidityUSD: latestTvl },
          ],
        },
      });

      const reading = await service.checkSmartContractRisk();

      expect(reading.coverageType).toBe("SmartContractRisk");
      expect(reading.severity).toBe(expectedSeverity);
      expect(reading.message).toContain("[DeFiLlama]");
    });

    it("degrades to a non-triggering low reading when DeFiLlama returns insufficient history", async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { tvl: [{ date: now, totalLiquidityUSD: 1_000_000 }] } });

      const reading = await service.checkSmartContractRisk();

      expect(reading.severity).toBe("low");
      expect(reading.value).toBe(reading.threshold);
      expect(reading.message).toContain("degraded");
    });

    it("degrades to a non-triggering low reading when DeFiLlama errors", async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error("defillama down"));

      const reading = await service.checkSmartContractRisk();

      expect(reading.severity).toBe("low");
      expect(reading.value).toBe(reading.threshold);
      expect(reading.message).toContain("degraded");
    });
  });

  describe("checkLiquidationShield", () => {
    afterEach(() => {
      jest.spyOn(Math, "random").mockRestore();
    });

    it("computes the collateral ratio from the mocked random source and labels it as mocked", async () => {
      jest.spyOn(Math, "random").mockReturnValue(0.5); // collateralRatio = 0.92 + (0.5 - 0.5) * 0.1 = 0.92

      const reading = await service.checkLiquidationShield();

      expect(reading.coverageType).toBe("LiquidationShield");
      expect(reading.value).toBeCloseTo(0.92);
      expect(reading.threshold).toBe(0.85);
      expect(reading.severity).toBe("low");
      expect(reading.message).toContain("[mocked — no NEXUS Protocol integration]");
    });

    it("can trigger when the random collateral ratio dips below the threshold", async () => {
      jest.spyOn(Math, "random").mockReturnValue(0); // collateralRatio = 0.92 + (0 - 0.5) * 0.3 = 0.77

      const reading = await service.checkLiquidationShield();

      expect(reading.value).toBeCloseTo(0.77);
      expect(reading.severity).toBe("triggered");
    });
  });

  describe("checkFlightDelay", () => {
    afterEach(() => {
      jest.spyOn(Math, "random").mockRestore();
    });

    it("reports a low-severity reading below the delay threshold", async () => {
      jest.spyOn(Math, "random").mockReturnValue(0); // delayMinutes = 0

      const reading = await service.checkFlightDelay("RF123");

      expect(reading.coverageType).toBe("FlightDelay");
      expect(reading.value).toBe(0);
      expect(reading.severity).toBe("low");
      expect(reading.message).toContain("RF123");
      expect(reading.message).toContain("[mocked — AviationStack requires a paid key]");
    });

    it("triggers once the delay reaches the threshold", async () => {
      jest.spyOn(Math, "random").mockReturnValue(0.4); // delayMinutes = floor(0.4 * 300) = 120

      const reading = await service.checkFlightDelay("RF123");

      expect(reading.value).toBe(120);
      expect(reading.severity).toBe("triggered");
    });
  });

  describe("checkAll", () => {
    it("aggregates the three real checks", async () => {
      mockedAxios.get
        .mockResolvedValueOnce({ data: { "usd-coin": { usd: 1.0 } } }) // StablecoinDepeg
        .mockResolvedValueOnce({ data: { stellar: { usd: 0.1, usd_24h_change: -1 } } }) // MarketCrash price
        .mockResolvedValueOnce({ data: { _embedded: { records: [] } } }) // MarketCrash ledger
        .mockResolvedValueOnce({
          data: { tvl: [{ date: 0, totalLiquidityUSD: 100 }, { date: 200_000, totalLiquidityUSD: 100 }] },
        }); // SmartContractRisk

      const readings = await service.checkAll();

      expect(readings.map((r) => r.coverageType)).toEqual([
        "StablecoinDepeg",
        "MarketCrash",
        "SmartContractRisk",
      ]);
    });
  });
});
