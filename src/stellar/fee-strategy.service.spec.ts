import { ConfigService } from "@nestjs/config";
import { BASE_FEE } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { FeeCeilingExceededError, FeeStrategyService } from "./fee-strategy.service";
import { SorobanRpcService } from "./soroban-rpc.service";

function buildConfig(overrides: Partial<AppConfig["fees"]> = {}): ConfigService<AppConfig, true> {
  const fees: AppConfig["fees"] = {
    ceilingStroops: "1000000",
    statsTtlMs: 15_000,
    profiles: {
      moderate: { percentile: 90, multiplier: 1.2 },
      aggressive: { percentile: 99, multiplier: 1.5 },
    },
    ...overrides,
  };
  return {
    get: jest.fn((key: string) => {
      if (key === "fees") return fees;
      if (key === "stellar") {
        return {
          sorobanRpcUrl: "https://soroban-testnet.stellar.org",
          networkPassphrase: "Test SDF Network ; September 2015",
        };
      }
      return undefined;
    }),
  } as unknown as ConfigService<AppConfig, true>;
}

const FEE_STATS_FIXTURE = {
  sorobanInclusionFee: {
    max: "10000",
    p99: "5000",
    p90: "1000",
    p10: "100",
    min: "100",
    mode: "200",
  },
};

function buildService(feeOverrides: Partial<AppConfig["fees"]> = {}) {
  const config = buildConfig(feeOverrides);
  const rpcService = new SorobanRpcService(config);
  const service = new FeeStrategyService(rpcService, config);
  return { service, rpcService };
}

describe("FeeStrategyService", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("picks the configured percentile from fee-stats and applies the multiplier", async () => {
    const { service, rpcService } = buildService();
    jest.spyOn(rpcService.server, "getFeeStats").mockResolvedValue(FEE_STATS_FIXTURE as never);

    // moderate: p90=1000 * 1.2 = 1200
    await expect(service.estimateInclusionFee("moderate")).resolves.toBe("1200");
  });

  it("yields a higher fee for the aggressive profile than moderate", async () => {
    const { service, rpcService } = buildService();
    jest.spyOn(rpcService.server, "getFeeStats").mockResolvedValue(FEE_STATS_FIXTURE as never);

    const moderate = BigInt(await service.estimateInclusionFee("moderate"));
    service.clearCache();
    const aggressive = BigInt(await service.estimateInclusionFee("aggressive"));
    // aggressive: p99=5000 * 1.5 = 7500
    expect(aggressive).toBe(7500n);
    expect(aggressive).toBeGreaterThan(moderate);
  });

  it("enforces BASE_FEE as a floor", async () => {
    const { service, rpcService } = buildService({
      profiles: {
        moderate: { percentile: 10, multiplier: 0.01 },
        aggressive: { percentile: 99, multiplier: 1.5 },
      },
    });
    jest.spyOn(rpcService.server, "getFeeStats").mockResolvedValue(FEE_STATS_FIXTURE as never);

    await expect(service.estimateInclusionFee("moderate")).resolves.toBe(BASE_FEE);
  });

  it("throws FeeCeilingExceededError when inclusion fee exceeds the ceiling", async () => {
    const { service, rpcService } = buildService({ ceilingStroops: "1000" });
    jest.spyOn(rpcService.server, "getFeeStats").mockResolvedValue(FEE_STATS_FIXTURE as never);

    await expect(service.estimateInclusionFee("aggressive")).rejects.toBeInstanceOf(FeeCeilingExceededError);
  });

  it("assertTotalUnderCeiling fails when inclusion+resource exceeds the ceiling", () => {
    const { service } = buildService({ ceilingStroops: "500" });
    expect(() => service.assertTotalUnderCeiling("400", "200")).toThrow(FeeCeilingExceededError);
  });

  it("degrades to BASE_FEE with a warning when getFeeStats fails", async () => {
    const { service, rpcService } = buildService();
    jest.spyOn(rpcService.server, "getFeeStats").mockRejectedValue(new Error("endpoint down"));
    const warnSpy = jest.spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, "warn");

    await expect(service.estimateInclusionFee("moderate")).resolves.toBe(BASE_FEE);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("caches fee stats so duplicate builds within the TTL do not re-fetch", async () => {
    const { service, rpcService } = buildService();
    const spy = jest.spyOn(rpcService.server, "getFeeStats").mockResolvedValue(FEE_STATS_FIXTURE as never);

    await service.estimateInclusionFee("moderate");
    await service.estimateInclusionFee("aggressive");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
