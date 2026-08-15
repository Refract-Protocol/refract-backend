import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Account,
  Keypair,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { PolicyService } from "./policy.service";
import { BuyPolicyDto } from "./dto/buy-policy.dto";

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const POOL_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));

function buildConfig(overrides: Partial<AppConfig["stellar"]> = {}): ConfigService<AppConfig, true> {
  const stellar: AppConfig["stellar"] = {
    network: "testnet",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: NETWORK_PASSPHRASE,
    poolContractId: POOL_CONTRACT_ID,
    policyContractId: "",
    oracleContractId: "",
    relayerSecret: "",
    ...overrides,
  };
  return { get: jest.fn().mockReturnValue(stellar) } as unknown as ConfigService<AppConfig, true>;
}

/** Decodes the single invokeHostFunction operation out of a built (unsigned) tx envelope. */
function decodeInvocation(txXdr: string) {
  const tx = TransactionBuilder.fromXDR(txXdr, NETWORK_PASSPHRASE) as Transaction;
  const op = tx.operations[0] as Extract<Transaction["operations"][number], { type: "invokeHostFunction" }>;
  const invocation = op.func.invokeContract();
  return {
    functionName: invocation.functionName().toString(),
    args: invocation.args().map((arg) => scValToNative(arg)),
  };
}

function buildDto(holder: string, overrides: Partial<BuyPolicyDto> = {}): BuyPolicyDto {
  return {
    holder,
    coverageType: 0,
    coverageAmount: "1000000000000", // 100,000 USDC in 1e7 base units
    durationDays: 365,
    ...overrides,
  };
}

/** A minimal simulateTransaction success response carrying just a return value. */
function simulateSuccess(retval: xdr.ScVal): rpc.Api.SimulateTransactionResponse {
  return { result: { retval, auth: [] } } as unknown as rpc.Api.SimulateTransactionResponse;
}

/** Mirrors refract-contracts' PoolConfig struct — only min/max coverage matter to this service. */
function poolConfigScVal(minCoverage: bigint, maxCoverage: bigint): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("base_premium_rate_bps"),
      val: nativeToScVal(300, { type: "u32" }),
    }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("lockup_days"), val: nativeToScVal(7, { type: "u32" }) }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("max_coverage"),
      val: nativeToScVal(maxCoverage, { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("max_utilization_bps"),
      val: nativeToScVal(8_000, { type: "u32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("min_coverage"),
      val: nativeToScVal(minCoverage, { type: "i128" }),
    }),
  ]);
}

// Comfortably outside every fixed coverageAmount used across the existing
// tests below (largest is 500,000 USDC = 5e12 base units), so the default
// mock never interferes with tests that aren't specifically about
// on-chain bounds.
const PERMISSIVE_BOUNDS = poolConfigScVal(0n, 1_000_000_000_000_000n);

describe("PolicyService", () => {
  let service: PolicyService;
  let holder: string;

  beforeEach(() => {
    service = new PolicyService(buildConfig());
    holder = Keypair.random().publicKey();
    // prepareTransaction normally simulates against a live network and
    // fills in Soroban resource fees — that's SDK behavior, not this
    // service's logic, so it's short-circuited to identity here (same
    // approach as ClaimSettlementService's tests).
    jest.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(async (id: string) => new Account(id, "1"));
    jest.spyOn(rpc.Server.prototype, "prepareTransaction").mockImplementation(async (tx) => tx as never);
    // Default: permissive on-chain bounds, so tests below aren't about
    // onChainCoverageBounds() unless they explicitly override this.
    jest.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue(simulateSuccess(PERMISSIVE_BOUNDS));
  });

  afterEach(() => {
    jest.restoreAllMocks();
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
    ])(
      "charges the catalog's annual base rate for coverageType %d over a 365-day policy",
      async (coverageType, baseRatePct) => {
        // 1,000 USDC — under every coverage type's maxCoverage (the lowest,
        // Flight Delay, caps at 2,000), so this covers all five rows.
        const coverageAmount = "10000000000";
        const triggerParams = coverageType === 4 ? { flightNumber: "BA249" } : undefined;

        const { policy } = await service.buy(
          buildDto(holder, { coverageType, coverageAmount, durationDays: 365, triggerParams })
        );

        const expectedPremium = BigInt(Math.floor(Number(BigInt(coverageAmount)) * (baseRatePct / 100)));
        const actualPremium = BigInt(policy.premium);
        const diff =
          actualPremium > expectedPremium ? actualPremium - expectedPremium : expectedPremium - actualPremium;
        expect(diff).toBeLessThanOrEqual(1n); // day-count/floor rounding only
      }
    );

    it("prorates the premium by duration", async () => {
      const coverageAmount = "1000000000000";

      const { policy: yearPolicy } = await service.buy(buildDto(holder, { coverageAmount, durationDays: 365 }));
      const { policy: monthPolicy } = await service.buy(buildDto(holder, { coverageAmount, durationDays: 30 }));

      const yearPremium = BigInt(yearPolicy.premium);
      const monthPremium = BigInt(monthPolicy.premium);
      const expectedMonthPremium = (yearPremium * 30n) / 365n;
      const diff =
        monthPremium > expectedMonthPremium
          ? monthPremium - expectedMonthPremium
          : expectedMonthPremium - monthPremium;
      expect(diff).toBeLessThanOrEqual(1n);
    });

    it("stores an active policy with the expected fields and an unsigned buy_policy invocation", async () => {
      const dto = buildDto(holder, { coverageType: 2, durationDays: 10 });
      const beforeSeconds = Math.floor(Date.now() / 1000);

      const { policy, txXdr, message } = await service.buy(dto);

      expect(policy.holder).toBe(holder);
      expect(policy.coverageType).toBe(2);
      expect(policy.coverageTypeName).toBe("Liquidation Shield");
      expect(policy.coverageAmount).toBe(dto.coverageAmount);
      expect(policy.durationDays).toBe(10);
      expect(policy.isActive).toBe(true);
      expect(policy.expiresAt).toBeGreaterThanOrEqual(beforeSeconds + 10 * 86_400);
      expect(message).toBe("Sign and submit to activate coverage");

      // The built tx must actually invoke RefractPool.buy_policy(holder,
      // PolicyParams{...}) with the PolicyParams struct field-encoded
      // exactly as refract-contracts' #[contracttype] derive expects
      // (map keys sorted alphabetically by field name; the CoverageType
      // enum as a one-element vec of its variant name) — a wrong shape
      // here would fail Soroban's argument check on every real invocation.
      const { functionName, args } = decodeInvocation(txXdr);
      expect(functionName).toBe("buy_policy");
      expect(args[0]).toBe(holder);
      expect(args[1]).toEqual({
        coverage_amount: BigInt(dto.coverageAmount),
        coverage_type: ["LiquidationShield"],
        duration_days: 10,
        trigger_threshold: 500n,
      });
    });

    it("persists triggerParams so ClaimService can read them back for scanning (e.g. flight number)", async () => {
      // Flight Delay caps at 2,000 USDC — stay under it.
      const dto = buildDto(holder, {
        coverageType: 4,
        coverageAmount: "10000000000",
        triggerParams: { flightNumber: "BA249" },
      });

      const { policy } = await service.buy(dto);
      const stored = service.findById(policy.id);

      expect(stored?.triggerParams).toEqual({ flightNumber: "BA249" });
    });

    it("leaves triggerParams undefined when the buyer didn't supply any", async () => {
      const { policy } = await service.buy(buildDto(holder, { coverageType: 0 }));

      expect(policy.triggerParams).toBeUndefined();
    });

    it("rejects buying Flight Delay coverage without a flightNumber in triggerParams", async () => {
      expect.assertions(2);
      try {
        await service.buy(buildDto(holder, { coverageType: 4 }));
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const response = (err as BadRequestException).getResponse() as { error: string };
        expect(response.error).toBe("Flight Delay coverage requires triggerParams.flightNumber");
      }
    });

    it("rejects Flight Delay coverage when triggerParams is present but flightNumber isn't a string", async () => {
      expect.assertions(1);
      try {
        await service.buy(buildDto(holder, { coverageType: 4, triggerParams: { flightNumber: 123 } }));
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
      }
    });

    it("allows buying Flight Delay coverage once a flightNumber is supplied", async () => {
      const { policy } = await service.buy(
        buildDto(holder, { coverageType: 4, coverageAmount: "10000000000", triggerParams: { flightNumber: "BA249" } })
      );

      expect(policy.triggerParams).toEqual({ flightNumber: "BA249" });
    });

    it("does not require triggerParams for non-Flight-Delay coverage types", async () => {
      await expect(service.buy(buildDto(holder, { coverageType: 0 }))).resolves.not.toThrow();
    });

    it("rejects a zero coverageAmount without contacting the network", async () => {
      const getAccountSpy = jest.spyOn(rpc.Server.prototype, "getAccount");
      expect.assertions(3);
      try {
        await service.buy(buildDto(holder, { coverageAmount: "0" }));
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const response = (err as BadRequestException).getResponse() as { error: string };
        expect(response.error).toBe("coverageAmount must be greater than zero");
        expect(getAccountSpy).not.toHaveBeenCalled();
      }
    });

    it("allows coverageAmount exactly at a type's advertised maxCoverage", async () => {
      // Flight Delay caps at 2,000 USDC.
      await expect(
        service.buy(
          buildDto(holder, { coverageType: 4, coverageAmount: "20000000000", triggerParams: { flightNumber: "BA249" } })
        )
      ).resolves.not.toThrow();
    });

    it("rejects coverageAmount beyond a type's advertised maxCoverage", async () => {
      // Flight Delay caps at 2,000 USDC; ask for 2,000.000001.
      expect.assertions(3);
      try {
        await service.buy(
          buildDto(holder, { coverageType: 4, coverageAmount: "20000000001", triggerParams: { flightNumber: "BA249" } })
        );
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const response = (err as BadRequestException).getResponse() as { error: string; maxCoverage: number };
        expect(response.error).toContain("Flight Delay maximum of 2000 USDC");
        expect(response.maxCoverage).toBe(2000);
      }
    });

    it("wraps a Soroban build failure (e.g. simulation rejection) in a BadRequestException", async () => {
      jest.spyOn(rpc.Server.prototype, "prepareTransaction").mockRejectedValue(new Error("InsufficientCapacity"));
      expect.assertions(2);

      try {
        await service.buy(buildDto(holder));
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const response = (err as BadRequestException).getResponse() as { error: string };
        expect(response.error).toContain("InsufficientCapacity");
      }
    });

    it("rejects coverageAmount above the pool's real on-chain max_coverage, even when the catalog would allow it", async () => {
      // SmartContractRisk's catalog maxCoverage is 500,000 USDC, but the
      // pool is (in this test) actually configured for only 5,000 —
      // exactly the mismatch between this service's per-type catalog and
      // the pool's single global bound that onChainCoverageBounds() exists
      // to catch.
      jest
        .spyOn(rpc.Server.prototype, "simulateTransaction")
        .mockResolvedValue(simulateSuccess(poolConfigScVal(1_000_000_000n, 50_000_000_000n)));
      const prepareSpy = jest.spyOn(rpc.Server.prototype, "prepareTransaction");
      expect.assertions(3);

      try {
        await service.buy(buildDto(holder, { coverageType: 3, coverageAmount: "100000000000" })); // 10,000 USDC
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const response = (err as BadRequestException).getResponse() as { error: string; maxCoverage: string };
        expect(response.maxCoverage).toBe("50000000000");
        expect(prepareSpy).not.toHaveBeenCalled();
      }
    });

    it("rejects coverageAmount below the pool's real on-chain min_coverage", async () => {
      jest
        .spyOn(rpc.Server.prototype, "simulateTransaction")
        .mockResolvedValue(simulateSuccess(poolConfigScVal(1_000_000_000n, 50_000_000_000n))); // min 100 USDC
      expect.assertions(2);

      try {
        // 10 USDC — under the catalog's own maxCoverage, so only the
        // on-chain min_coverage check should be able to reject this.
        await service.buy(buildDto(holder, { coverageType: 0, coverageAmount: "100000000" }));
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const response = (err as BadRequestException).getResponse() as { error: string; minCoverage: string };
        expect(response.minCoverage).toBe("1000000000");
      }
    });

    it("allows a coverageAmount within both the catalog's and the pool's on-chain bounds", async () => {
      jest
        .spyOn(rpc.Server.prototype, "simulateTransaction")
        .mockResolvedValue(simulateSuccess(poolConfigScVal(1_000_000_000n, 50_000_000_000n)));

      await expect(
        service.buy(buildDto(holder, { coverageType: 0, coverageAmount: "40000000000" })) // 4,000 USDC
      ).resolves.not.toThrow();
    });
  });

  describe("lookups and lifecycle", () => {
    it("findById/findByHolder return a bought policy, and listActive drops it once deactivated", async () => {
      const { policy } = await service.buy(buildDto(holder));

      expect(service.findById(policy.id)).toEqual(policy);
      expect(service.findByHolder(holder)).toEqual([policy]);
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
