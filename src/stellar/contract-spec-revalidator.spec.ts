/**
 * Tests for ContractSpecRevalidator:
 *   1. Mocked spec change blocks publication and settlement, fires alert
 *   2. RPC errors produce "unknown" (not "mismatch") and also block
 *   3. Block survives a restart (persisted state loaded on init)
 *   4. Diff-report correctness
 *   5. Operator override clears the block
 */

import { SchedulerRegistry } from "@nestjs/schedule";
import { rpc } from "@stellar/stellar-sdk";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { AlertingService } from "../alerting/alerting.service";
import { DbService } from "../db/db.service";
import { ContractSpecRevalidator, RevalidationResult } from "./contract-spec-revalidator";
import * as PoolContractInterface from "./pool-contract-interface.service";

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildConfig(overrides: Partial<AppConfig["stellar"]> = {}): ConfigService<AppConfig, true> {
  return {
    get: jest.fn((key: string) => {
      if (key === "stellar") {
        return {
          sorobanRpcUrl: "https://soroban-testnet.stellar.org",
          poolContractId: "CPOOL0000000000000000000000000000000000000000000000000000",
          oracleContractId: "CORACLE000000000000000000000000000000000000000000000000",
          ...overrides,
        };
      }
      if (key === "contractRevalidation") return { intervalSeconds: 300 };
      return undefined;
    }),
  } as unknown as ConfigService<AppConfig, true>;
}

function buildAlerting(): jest.Mocked<AlertingService> {
  return { emit: jest.fn(), listRecent: jest.fn() } as unknown as jest.Mocked<AlertingService>;
}

function buildDb(persistedState?: RevalidationResult): jest.Mocked<DbService> {
  return {
    isAvailable: jest.fn().mockReturnValue(true),
    query: jest.fn().mockImplementation((sql: string) => {
      if (sql.includes("SELECT value") && persistedState) {
        return Promise.resolve({ rows: [{ value: JSON.stringify(persistedState) }] });
      }
      return Promise.resolve({ rows: [] });
    }),
  } as unknown as jest.Mocked<DbService>;
}

function buildSchedulerRegistry(): jest.Mocked<SchedulerRegistry> {
  return {
    addCronJob: jest.fn(),
    doesExist: jest.fn().mockReturnValue(false),
    deleteCronJob: jest.fn(),
  } as unknown as jest.Mocked<SchedulerRegistry>;
}

function buildRevalidator(
  overrides: Partial<AppConfig["stellar"]> = {},
  persistedState?: RevalidationResult,
) {
  const config = buildConfig(overrides);
  const alerting = buildAlerting();
  const db = buildDb(persistedState);
  const scheduler = buildSchedulerRegistry();
  const svc = new ContractSpecRevalidator(config, alerting, db, scheduler);
  return { svc, alerting, db, scheduler };
}

function validWasm(): Buffer {
  // Minimal valid WASM header (magic + version) — actual parsing is mocked.
  return Buffer.from("0061736d01000000", "hex");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ContractSpecRevalidator", () => {
  afterEach(() => jest.restoreAllMocks());

  // 1. Mocked spec change blocks publication/settlement and fires alert ───────

  it("blocks publication and fires critical alert on spec mismatch", async () => {
    const { svc, alerting } = buildRevalidator();

    jest
      .spyOn(rpc.Server.prototype, "getContractWasmByContractId")
      .mockResolvedValue(validWasm() as never);
    jest.spyOn(PoolContractInterface, "parseContractSpec").mockReturnValue({} as never);
    jest.spyOn(PoolContractInterface, "validatePoolContractSpec").mockReturnValue([
      "missing function buy_policy",
      "process_claim arguments expected (policy_id:string) but found (id:u64)",
    ]);

    await svc.revalidate();

    expect(alerting.emit).toHaveBeenCalledWith(
      "critical",
      expect.stringContaining("mismatch"),
      expect.stringContaining("buy_policy"),
      expect.anything(),
    );

    expect(() => svc.assertPublicationAllowed()).toThrow(/blocked/);
    expect(() => svc.assertSettlementAllowed()).toThrow(/blocked/);
  });

  it("includes correct diff entries for changed and removed functions", async () => {
    const { svc } = buildRevalidator();

    jest
      .spyOn(rpc.Server.prototype, "getContractWasmByContractId")
      .mockResolvedValue(validWasm() as never);
    jest.spyOn(PoolContractInterface, "parseContractSpec").mockReturnValue({} as never);
    jest.spyOn(PoolContractInterface, "validatePoolContractSpec").mockReturnValue([
      "missing function pool_config",
      "buy_policy arguments expected (holder:address, params:udt:PolicyParams) but found (holder:address)",
    ]);

    const result = await svc.revalidate();

    expect(result.state).toBe("mismatch");
    const poolDiff = result.pool.diff;
    expect(poolDiff).toContainEqual(expect.objectContaining({ name: "pool_config", change: "removed" }));
    expect(poolDiff).toContainEqual(expect.objectContaining({ name: "buy_policy", change: "changed" }));
  });

  // 2. RPC errors produce "unknown", not "mismatch" ─────────────────────────

  it("returns unknown state when RPC is unavailable and blocks both operations", async () => {
    const { svc, alerting } = buildRevalidator();

    jest
      .spyOn(rpc.Server.prototype, "getContractWasmByContractId")
      .mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:8000"));

    const result = await svc.revalidate();

    expect(result.state).toBe("unknown");
    expect(result.pool.state).toBe("unknown");
    expect(alerting.emit).toHaveBeenCalledWith(
      "warning",
      expect.stringContaining("unknown"),
      expect.anything(),
    );

    expect(() => svc.assertPublicationAllowed()).toThrow(/blocked/);
    expect(() => svc.assertSettlementAllowed()).toThrow(/blocked/);
  });

  it("does not classify an RPC timeout as a mismatch", async () => {
    const { svc } = buildRevalidator();

    jest
      .spyOn(rpc.Server.prototype, "getContractWasmByContractId")
      .mockRejectedValue(new Error("Request timeout after 5000ms"));

    const result = await svc.revalidate();

    expect(result.state).toBe("unknown");
    expect(result.pool.state).toBe("unknown");
    expect(result.pool.errors[0]).toMatch(/RPC unavailable/);
  });

  // 3. Block survives a restart ───────────────────────────────────────────────

  it("loads persisted mismatch state on init and blocks immediately before first revalidation", async () => {
    const blockedState: RevalidationResult = {
      state: "mismatch",
      pool: {
        contractId: "CPOOL",
        contractName: "pool",
        state: "mismatch",
        checkedAt: new Date().toISOString(),
        errors: ["missing function buy_policy"],
        diff: [{ name: "buy_policy", change: "removed" }],
        wasmHash: null,
      },
      oracle: {
        contractId: "CORACLE",
        contractName: "oracle",
        state: "valid",
        checkedAt: new Date().toISOString(),
        errors: [],
        diff: [],
        wasmHash: null,
      },
      blockedAt: new Date().toISOString(),
      operatorOverride: null,
    };

    // Build with a DB that returns the persisted state.
    const { svc } = buildRevalidator({}, blockedState);

    // Only load state — don't call revalidate() yet (simulating fresh restart
    // before the scheduler's first tick).
    await (svc as unknown as { loadPersistedState(): Promise<void> }).loadPersistedState();

    expect(() => svc.assertPublicationAllowed()).toThrow(/blocked/);
    expect(() => svc.assertSettlementAllowed()).toThrow(/blocked/);
  });

  // 4. Diff-report correctness ───────────────────────────────────────────────

  it("exposes diff report through getLastResult() after a mismatch", async () => {
    const { svc } = buildRevalidator();

    jest
      .spyOn(rpc.Server.prototype, "getContractWasmByContractId")
      .mockResolvedValue(validWasm() as never);
    jest.spyOn(PoolContractInterface, "parseContractSpec").mockReturnValue({} as never);
    jest.spyOn(PoolContractInterface, "validatePoolContractSpec").mockReturnValue([
      "process_claim result expected result:i128 but found void",
    ]);

    await svc.revalidate();

    const report = svc.getLastResult();
    expect(report).not.toBeNull();
    expect(report!.state).toBe("mismatch");
    expect(report!.pool.diff[0]).toEqual(
      expect.objectContaining({
        name: "process_claim",
        change: "changed",
        expected: "result:i128",
        actual: "void",
      }),
    );
  });

  it("clears block and diff after a successful revalidation", async () => {
    const { svc } = buildRevalidator();

    // First: inject a mismatch.
    jest
      .spyOn(rpc.Server.prototype, "getContractWasmByContractId")
      .mockResolvedValueOnce(validWasm() as never);
    jest.spyOn(PoolContractInterface, "parseContractSpec").mockReturnValue({} as never);
    jest
      .spyOn(PoolContractInterface, "validatePoolContractSpec")
      .mockReturnValueOnce(["missing function pool_config"])
      .mockReturnValue([]);

    await svc.revalidate();
    expect(svc.getLastResult()!.state).toBe("mismatch");

    // Second: spec is now clean.
    jest
      .spyOn(rpc.Server.prototype, "getContractWasmByContractId")
      .mockResolvedValue(validWasm() as never);

    await svc.revalidate();

    expect(svc.getLastResult()!.state).toBe("valid");
    expect(() => svc.assertPublicationAllowed()).not.toThrow();
    expect(() => svc.assertSettlementAllowed()).not.toThrow();
  });

  // 5. Operator override ─────────────────────────────────────────────────────

  it("operator override clears the publication block without requiring a clean spec", async () => {
    const { svc, alerting } = buildRevalidator();

    jest
      .spyOn(rpc.Server.prototype, "getContractWasmByContractId")
      .mockResolvedValue(validWasm() as never);
    jest.spyOn(PoolContractInterface, "parseContractSpec").mockReturnValue({} as never);
    jest.spyOn(PoolContractInterface, "validatePoolContractSpec").mockReturnValue(["missing function buy_policy"]);

    await svc.revalidate();
    expect(() => svc.assertPublicationAllowed()).toThrow();

    await svc.applyOperatorOverride("Confirmed safe — hotfix pending", "ops-admin");

    expect(() => svc.assertPublicationAllowed()).not.toThrow();
    expect(alerting.emit).toHaveBeenCalledWith(
      "warning",
      expect.stringContaining("overridden"),
      expect.stringContaining("ops-admin"),
      expect.anything(),
    );
  });

  it("removing the override restores the block", async () => {
    const { svc } = buildRevalidator();

    jest
      .spyOn(rpc.Server.prototype, "getContractWasmByContractId")
      .mockResolvedValue(validWasm() as never);
    jest.spyOn(PoolContractInterface, "parseContractSpec").mockReturnValue({} as never);
    jest.spyOn(PoolContractInterface, "validatePoolContractSpec").mockReturnValue(["missing function buy_policy"]);

    await svc.revalidate();
    await svc.applyOperatorOverride("temp", "admin");
    expect(() => svc.assertPublicationAllowed()).not.toThrow();

    await svc.clearOperatorOverride();
    expect(() => svc.assertPublicationAllowed()).toThrow(/blocked/);
  });

  // 6. State persistence ─────────────────────────────────────────────────────

  it("persists state to DB after each revalidation", async () => {
    const { svc, db } = buildRevalidator();

    jest
      .spyOn(rpc.Server.prototype, "getContractWasmByContractId")
      .mockResolvedValue(validWasm() as never);
    jest.spyOn(PoolContractInterface, "parseContractSpec").mockReturnValue({} as never);
    jest.spyOn(PoolContractInterface, "validatePoolContractSpec").mockReturnValue([]);

    await svc.revalidate();

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO control_plane_flags"),
      expect.arrayContaining(["contract_spec_validation_state"]),
    );
  });
});
