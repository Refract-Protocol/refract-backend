import { OracleGateway } from "./oracle.gateway";
import { OraclePublisherService } from "./oracle-publisher.service";
import { OracleReading } from "./oracle-reading";
import { OracleScheduler } from "./oracle.scheduler";
import { OracleService } from "./oracle.service";

function reading(
  coverageType: string,
  value: number,
  threshold: number,
  severity: OracleReading["severity"] = "low",
): OracleReading {
  return {
    coverageType,
    type: "oracle_update",
    value,
    threshold,
    severity,
    message: "test feed",
  };
}

describe("OracleScheduler", () => {
  let scheduler: OracleScheduler;
  let oracleService: jest.Mocked<OracleService>;
  let oracleGateway: jest.Mocked<OracleGateway>;
  let oraclePublisher: jest.Mocked<OraclePublisherService>;

  beforeEach(() => {
    jest.useFakeTimers();
    oracleService = {
      checkStablecoinDepeg: jest.fn().mockResolvedValue(reading("StablecoinDepeg", 0.97, 0.95)),
      checkMarketCrash: jest.fn().mockResolvedValue(reading("MarketCrash", -5, -30)),
      checkLiquidationShield: jest.fn().mockResolvedValue(reading("LiquidationShield", 0.92, 0.85)),
      checkSmartContractRisk: jest.fn().mockResolvedValue(reading("SmartContractRisk", -2, -50)),
      checkFlightDelay: jest.fn().mockResolvedValue(reading("FlightDelay", 0, 120)),
      getQuotaPressure: jest.fn().mockReturnValue(0),
    } as unknown as jest.Mocked<OracleService>;
    oracleGateway = { broadcastAlert: jest.fn() } as unknown as jest.Mocked<OracleGateway>;
    oraclePublisher = { maybePublish: jest.fn().mockResolvedValue(null) } as unknown as jest.Mocked<OraclePublisherService>;
    scheduler = new OracleScheduler(oracleService, oracleGateway, oraclePublisher);
  });

  afterEach(() => {
    scheduler.onModuleDestroy();
    jest.useRealTimers();
  });

  it("polls each source independently and accelerates feeds near a trigger", async () => {
    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);

    expect(oracleService.checkStablecoinDepeg).toHaveBeenCalledTimes(1);
    expect(oracleService.checkMarketCrash).toHaveBeenCalledTimes(1);
    expect(oracleService.checkLiquidationShield).toHaveBeenCalledTimes(1);
    expect(oracleService.checkSmartContractRisk).toHaveBeenCalledTimes(1);
    expect(oracleService.checkFlightDelay).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(15_000);

    expect(oracleService.checkStablecoinDepeg).toHaveBeenCalledTimes(2);
    expect(oracleService.checkMarketCrash).toHaveBeenCalledTimes(1);
  });

  it("broadcasts trigger alerts and publishes readings", async () => {
    oracleService.checkMarketCrash.mockResolvedValueOnce(reading("MarketCrash", -35, -30, "triggered"));
    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);

    expect(oracleGateway.broadcastAlert).toHaveBeenCalledWith(
      expect.objectContaining({ coverageType: "MarketCrash", severity: "triggered" }),
    );
    expect(oraclePublisher.maybePublish).toHaveBeenCalledTimes(5);
  });

  it("stops scheduling after module shutdown", async () => {
    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    scheduler.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(300_000);

    expect(oracleService.checkStablecoinDepeg).toHaveBeenCalledTimes(1);
  });
});
