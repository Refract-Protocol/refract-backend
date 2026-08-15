import { OracleScheduler } from "./oracle.scheduler";
import { OracleService } from "./oracle.service";
import { OracleGateway } from "./oracle.gateway";
import { OracleReading } from "./oracle-reading";

function buildReading(overrides: Partial<OracleReading> = {}): OracleReading {
  return {
    coverageType: "StablecoinDepeg",
    type: "oracle_update",
    value: 1.0,
    threshold: 0.95,
    severity: "low",
    message: "USDC price: $1.0000",
    ...overrides,
  };
}

function buildServices() {
  const oracleService = { checkAll: jest.fn() } as unknown as jest.Mocked<OracleService>;
  const oracleGateway = { broadcastAlert: jest.fn() } as unknown as jest.Mocked<OracleGateway>;
  return { oracleService, oracleGateway };
}

describe("OracleScheduler", () => {
  describe("pollOracles", () => {
    it("broadcasts readings above 'low' severity and skips low ones", async () => {
      const { oracleService, oracleGateway } = buildServices();
      const low = buildReading({ coverageType: "StablecoinDepeg", severity: "low" });
      const high = buildReading({ coverageType: "MarketCrash", severity: "high" });
      const triggered = buildReading({ coverageType: "SmartContractRisk", severity: "triggered" });
      oracleService.checkAll.mockResolvedValue([low, high, triggered]);
      const scheduler = new OracleScheduler(oracleService, oracleGateway);

      await scheduler.pollOracles();

      expect(oracleGateway.broadcastAlert).toHaveBeenCalledTimes(2);
      expect(oracleGateway.broadcastAlert).toHaveBeenCalledWith(high);
      expect(oracleGateway.broadcastAlert).toHaveBeenCalledWith(triggered);
      expect(oracleGateway.broadcastAlert).not.toHaveBeenCalledWith(low);
    });

    it("does not broadcast anything when every reading is 'low' severity", async () => {
      const { oracleService, oracleGateway } = buildServices();
      oracleService.checkAll.mockResolvedValue([buildReading({ severity: "low" })]);
      const scheduler = new OracleScheduler(oracleService, oracleGateway);

      await scheduler.pollOracles();

      expect(oracleGateway.broadcastAlert).not.toHaveBeenCalled();
    });

    it("catches and logs an error from checkAll() instead of throwing", async () => {
      const { oracleService, oracleGateway } = buildServices();
      oracleService.checkAll.mockRejectedValue(new Error("all sources down"));
      const scheduler = new OracleScheduler(oracleService, oracleGateway);

      await expect(scheduler.pollOracles()).resolves.toBeUndefined();
      expect(oracleGateway.broadcastAlert).not.toHaveBeenCalled();
    });
  });
});
