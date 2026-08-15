import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Account, Keypair, StrKey, Transaction, TransactionBuilder, rpc, scValToNative } from "@stellar/stellar-sdk";
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
