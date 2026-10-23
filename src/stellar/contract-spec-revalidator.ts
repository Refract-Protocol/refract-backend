import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { CronJob } from "cron";
import { rpc } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { AlertingService } from "../alerting/alerting.service";
import { DbService } from "../db/db.service";
import {
  validatePoolContractSpec,
  parseContractSpec,
  extractContractSpec,
} from "./pool-contract-interface.service";

/**
 * Three possible states for the contract-spec validation control-plane flag.
 *
 * - valid:    last check passed; publication and settlement are allowed.
 * - mismatch: spec diverged from expected; publication and settlement are BLOCKED.
 * - unknown:  RPC was unreachable; we fail-closed (block) but distinguish
 *             this from a confirmed mismatch so operators can tell the
 *             difference between an upgrade and a connectivity blip.
 */
export type ValidationState = "valid" | "mismatch" | "unknown";

export interface FunctionDiff {
  name: string;
  change: "added" | "removed" | "changed";
  expected?: string;
  actual?: string;
}

export interface ContractDiffReport {
  contractId: string;
  contractName: "pool" | "oracle";
  state: ValidationState;
  checkedAt: string;
  errors: string[];
  diff: FunctionDiff[];
  wasmHash: string | null;
}

export interface RevalidationResult {
  state: ValidationState;
  pool: ContractDiffReport;
  oracle: ContractDiffReport;
  blockedAt: string | null;
  operatorOverride: OperatorOverride | null;
}

export interface OperatorOverride {
  reason: string;
  actor: string;
  overriddenAt: string;
}

const REVALIDATION_JOB_NAME = "contract-spec-revalidation";
const CONTROL_PLANE_KEY = "contract_spec_validation_state";

/**
 * Periodically and on-demand revalidates the live Soroban contract specs for
 * the pool and oracle contracts against the backend's expected ABI.
 *
 * A mismatch (or RPC unavailability) sets a durable block — persisted in
 * Postgres — so the block survives restarts. It clears only after a
 * successful revalidation or an explicit operator override.
 *
 * Callers (OraclePublisherService, ClaimSettlementService) inject this and
 * call assertPublicationAllowed() / assertSettlementAllowed() at their gates.
 */
@Injectable()
export class ContractSpecRevalidator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContractSpecRevalidator.name);
  private readonly server: rpc.Server;
  private readonly poolContractId: string;
  private readonly oracleContractId: string;
  private readonly intervalSeconds: number;

  /** In-memory cache of the last result; DB is the durable source of truth. */
  private lastResult: RevalidationResult | null = null;

  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly alerting: AlertingService,
    private readonly db: DbService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    const stellar = configService.get("stellar", { infer: true });
    this.server = new rpc.Server(stellar.sorobanRpcUrl);
    this.poolContractId = stellar.poolContractId;
    this.oracleContractId = stellar.oracleContractId;
    this.intervalSeconds = configService.get("contractRevalidation", { infer: true })?.intervalSeconds ?? 300;
  }

  async onModuleInit(): Promise<void> {
    // Load any persisted state so the block survives a restart before the
    // first scheduler tick.
    await this.loadPersistedState();

    if (!this.poolContractId && !this.oracleContractId) {
      this.logger.warn("No contract IDs configured — skipping revalidation scheduler");
      return;
    }

    // Run immediately at startup, then on the configured interval.
    await this.revalidate();

    const job = new CronJob(`*/${this.intervalSeconds} * * * * *`, () => {
      void this.revalidate();
    });
    this.schedulerRegistry.addCronJob(REVALIDATION_JOB_NAME, job);
    job.start();
    this.logger.log(`Contract spec revalidation scheduled every ${this.intervalSeconds}s`);
  }

  onModuleDestroy(): void {
    if (this.schedulerRegistry.doesExist("cron", REVALIDATION_JOB_NAME)) {
      this.schedulerRegistry.deleteCronJob(REVALIDATION_JOB_NAME);
    }
  }

  // ── Public gate ───────────────────────────────────────────────────────────

  /**
   * Throws if the current validation state blocks publication.
   * Called by OraclePublisherService.maybePublish().
   */
  assertPublicationAllowed(): void {
    this.assertAllowed("publication");
  }

  /**
   * Throws if the current validation state blocks settlement.
   * Called by ClaimSettlementService before submitting a payout.
   */
  assertSettlementAllowed(): void {
    this.assertAllowed("settlement");
  }

  private assertAllowed(operation: string): void {
    const result = this.lastResult;
    if (!result) return; // Not yet initialised — allow (startup path handled separately)

    // Operator override clears the block unconditionally.
    if (result.operatorOverride) return;

    if (result.state === "mismatch") {
      throw new Error(
        `Contract spec mismatch — ${operation} blocked. Run GET /ops/contracts/diff-report for details.`,
      );
    }
    if (result.state === "unknown") {
      throw new Error(
        `Contract spec validation state unknown (RPC unreachable) — ${operation} blocked until RPC recovers.`,
      );
    }
  }

  // ── Revalidation ──────────────────────────────────────────────────────────

  async revalidate(): Promise<RevalidationResult> {
    const [poolReport, oracleReport] = await Promise.all([
      this.checkContract("pool", this.poolContractId),
      this.checkContract("oracle", this.oracleContractId),
    ]);

    const anyMismatch = poolReport.state === "mismatch" || oracleReport.state === "mismatch";
    const anyUnknown = poolReport.state === "unknown" || oracleReport.state === "unknown";
    const overallState: ValidationState = anyMismatch ? "mismatch" : anyUnknown ? "unknown" : "valid";

    // Preserve existing operator override and blockedAt unless we just cleared mismatch.
    const prior = this.lastResult;
    const override = prior?.operatorOverride ?? null;
    const blockedAt =
      overallState !== "valid"
        ? (prior?.blockedAt ?? new Date().toISOString())
        : null;

    const result: RevalidationResult = {
      state: overallState,
      pool: poolReport,
      oracle: oracleReport,
      blockedAt,
      operatorOverride: overallState === "valid" ? null : override,
    };

    this.lastResult = result;
    await this.persistState(result);

    if (overallState === "mismatch") {
      const affectedNames = [
        ...(poolReport.state === "mismatch" ? poolReport.diff.map((d) => `pool.${d.name}`) : []),
        ...(oracleReport.state === "mismatch" ? oracleReport.diff.map((d) => `oracle.${d.name}`) : []),
      ];
      this.alerting.emit(
        "critical",
        "Contract spec mismatch — publication and settlement blocked",
        `Differing functions: ${affectedNames.join(", ") || "see diff report"}`,
        { poolErrors: poolReport.errors, oracleErrors: oracleReport.errors },
      );
    } else if (overallState === "unknown") {
      this.alerting.emit(
        "warning",
        "Contract spec validation state unknown",
        "RPC unreachable — publication and settlement blocked until RPC recovers",
      );
    } else if (prior?.state !== "valid") {
      this.logger.log("Contract spec revalidation passed — block cleared");
    }

    return result;
  }

  getLastResult(): RevalidationResult | null {
    return this.lastResult;
  }

  // ── Operator override ─────────────────────────────────────────────────────

  async applyOperatorOverride(reason: string, actor: string): Promise<void> {
    if (!this.lastResult) {
      throw new Error("No validation result yet — cannot apply override");
    }
    const override: OperatorOverride = {
      reason,
      actor,
      overriddenAt: new Date().toISOString(),
    };
    this.lastResult = { ...this.lastResult, operatorOverride: override };
    await this.persistState(this.lastResult);
    this.alerting.emit(
      "warning",
      "Contract spec block overridden by operator",
      `Actor: ${actor}. Reason: ${reason}`,
      { actor, reason },
    );
    this.logger.warn(`Operator override applied by ${actor}: ${reason}`);
  }

  async clearOperatorOverride(): Promise<void> {
    if (!this.lastResult) return;
    this.lastResult = { ...this.lastResult, operatorOverride: null };
    await this.persistState(this.lastResult);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async checkContract(
    name: "pool" | "oracle",
    contractId: string,
  ): Promise<ContractDiffReport> {
    if (!contractId) {
      return this.emptyReport(name, contractId, "valid");
    }

    try {
      const wasm = await this.server.getContractWasmByContractId(contractId);
      const wasmHash = Buffer.from(wasm).subarray(0, 8).toString("hex");

      // Oracle contract shares the same spec structure as the pool contract
      // (RefractOracle exposes a subset of the same functions). Re-use the
      // same validator — errors will be empty for contracts that don't
      // implement functions we check, which is acceptable for now.
      const spec = parseContractSpec(wasm);
      const errors = validatePoolContractSpec(spec);

      if (errors.length > 0) {
        return {
          contractId,
          contractName: name,
          state: "mismatch",
          checkedAt: new Date().toISOString(),
          errors,
          diff: this.errorsToFunctionDiff(errors),
          wasmHash,
        };
      }

      return {
        contractId,
        contractName: name,
        state: "valid",
        checkedAt: new Date().toISOString(),
        errors: [],
        diff: [],
        wasmHash,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Distinguish a genuine spec mismatch from RPC/WASM errors — the
      // latter are classified as "unknown" so we don't cry wolf about
      // upgrades that haven't happened.
      if (message.includes("interface mismatch") || message.includes("missing function") || message.includes("expected")) {
        return {
          contractId,
          contractName: name,
          state: "mismatch",
          checkedAt: new Date().toISOString(),
          errors: [message],
          diff: this.errorsToFunctionDiff([message]),
          wasmHash: null,
        };
      }

      this.logger.warn(`RPC unavailable during ${name} contract spec check: ${message}`);
      return {
        contractId,
        contractName: name,
        state: "unknown",
        checkedAt: new Date().toISOString(),
        errors: [`RPC unavailable: ${message}`],
        diff: [],
        wasmHash: null,
      };
    }
  }

  /**
   * Converts error strings like "buy_policy arguments expected (...) but found (...)"
   * into structured FunctionDiff records for the admin API.
   */
  private errorsToFunctionDiff(errors: string[]): FunctionDiff[] {
    return errors.map((e) => {
      const missingMatch = /^missing (function|struct|enum) (\S+)$/.exec(e);
      if (missingMatch) {
        return { name: missingMatch[2], change: "removed" as const };
      }
      const changeMatch = /^(\S+) (?:arguments|result) expected (.+) but found (.+)$/.exec(e);
      if (changeMatch) {
        return {
          name: changeMatch[1],
          change: "changed" as const,
          expected: changeMatch[2],
          actual: changeMatch[3],
        };
      }
      return { name: e, change: "changed" as const };
    });
  }

  private emptyReport(
    name: "pool" | "oracle",
    contractId: string,
    state: ValidationState,
  ): ContractDiffReport {
    return {
      contractId,
      contractName: name,
      state,
      checkedAt: new Date().toISOString(),
      errors: [],
      diff: [],
      wasmHash: null,
    };
  }

  // ── Durable state (Postgres) ──────────────────────────────────────────────

  private async persistState(result: RevalidationResult): Promise<void> {
    if (!this.db.isAvailable()) return;
    try {
      await this.db.query(
        `INSERT INTO control_plane_flags (key, value, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
        [CONTROL_PLANE_KEY, JSON.stringify(result)],
      );
    } catch (err) {
      this.logger.error(
        "Failed to persist contract spec validation state",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async loadPersistedState(): Promise<void> {
    if (!this.db.isAvailable()) return;
    try {
      const { rows } = await this.db.query<{ value: string }>(
        `SELECT value FROM control_plane_flags WHERE key = $1`,
        [CONTROL_PLANE_KEY],
      );
      if (rows[0]) {
        this.lastResult = JSON.parse(rows[0].value) as RevalidationResult;
        if (this.lastResult.state !== "valid") {
          this.logger.warn(
            `Loaded persisted contract spec state: ${this.lastResult.state} — block is active`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        "Could not load persisted contract spec state",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
