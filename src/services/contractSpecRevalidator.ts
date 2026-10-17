/**
 * Runtime Contract Interface (ABI) Revalidator for RefractOracle and Pool Contracts (Issue #284)
 *
 * Revalidates live Soroban contract specs on periodic schedules and on detected
 * WASM hash / ledger upgrades. Persists validation state across restarts, distinguishes
 * RPC unavailability (`unknown`) from ABI `mismatch`, blocks publication and settlement
 * on mismatch/unknown, and produces structured function/parameter diff reports.
 */

export type ContractTargetName = "RefractOracle" | "InsurancePool";

export type SpecValidationStatus = "valid" | "mismatch" | "unknown" | "operator_overridden";

export interface ContractParamSpec {
  name: string;
  type: string;
}

export interface ContractFunctionSpec {
  name: string;
  inputs: ContractParamSpec[];
  outputs: string[];
}

export interface ContractAbiSpec {
  contractName: ContractTargetName;
  contractAddress: string;
  wasmHash: string;
  functions: ContractFunctionSpec[];
}

export interface FunctionAbiDiff {
  functionName: string;
  expectedSignature: string;
  actualSignature: string;
}

export interface ContractSpecDiffReport {
  contractName: ContractTargetName;
  contractAddress: string;
  expectedWasmHash?: string;
  observedWasmHash?: string;
  addedFunctions: string[];
  removedFunctions: string[];
  changedFunctions: FunctionAbiDiff[];
  hasBreakingChanges: boolean;
}

export interface PersistedContractValidationRecord {
  contractName: ContractTargetName;
  status: SpecValidationStatus;
  canPublishOrSettle: boolean;
  circuitBreakerTripped: boolean;
  lastCheckedAtMs: number;
  lastObservedWasmHash?: string;
  diffReport?: ContractSpecDiffReport;
  lastError?: string;
  overrideActorId?: string;
  overrideReason?: string;
  highSeverityAlert?: string;
}

export interface ContractSpecValidationStore {
  load(contractName: ContractTargetName): PersistedContractValidationRecord | undefined;
  save(record: PersistedContractValidationRecord): void;
}

export class InMemoryContractSpecValidationStore implements ContractSpecValidationStore {
  private readonly records = new Map<ContractTargetName, PersistedContractValidationRecord>();

  load(contractName: ContractTargetName): PersistedContractValidationRecord | undefined {
    const rec = this.records.get(contractName);
    return rec ? JSON.parse(JSON.stringify(rec)) : undefined;
  }

  save(record: PersistedContractValidationRecord): void {
    this.records.set(record.contractName, JSON.parse(JSON.stringify(record)));
  }
}

export function formatFunctionSignature(fn: ContractFunctionSpec): string {
  const params = fn.inputs.map((p) => `${p.name}:${p.type}`).join(", ");
  const returns = fn.outputs.join(", ") || "void";
  return `${fn.name}(${params}) -> ${returns}`;
}

/**
 * Computes a structured ABI diff report between the expected contract interface
 * and the live on-chain contract spec.
 * Removal of any expected function or change in parameter/return types is treated
 * as a breaking ABI change (`hasBreakingChanges = true`).
 */
export function diffContractSpecs(
  expected: ContractAbiSpec,
  actual: ContractAbiSpec
): ContractSpecDiffReport {
  const expectedMap = new Map(expected.functions.map((f) => [f.name, f]));
  const actualMap = new Map(actual.functions.map((f) => [f.name, f]));

  const addedFunctions: string[] = [];
  const removedFunctions: string[] = [];
  const changedFunctions: FunctionAbiDiff[] = [];

  for (const [name, expFn] of expectedMap.entries()) {
    const actFn = actualMap.get(name);
    if (!actFn) {
      removedFunctions.push(name);
      continue;
    }
    const expSig = formatFunctionSignature(expFn);
    const actSig = formatFunctionSignature(actFn);
    if (expSig !== actSig) {
      changedFunctions.push({
        functionName: name,
        expectedSignature: expSig,
        actualSignature: actSig,
      });
    }
  }

  for (const name of actualMap.keys()) {
    if (!expectedMap.has(name)) {
      addedFunctions.push(name);
    }
  }

  const hasBreakingChanges =
    removedFunctions.length > 0 || changedFunctions.length > 0;

  return {
    contractName: expected.contractName,
    contractAddress: expected.contractAddress,
    expectedWasmHash: expected.wasmHash,
    observedWasmHash: actual.wasmHash,
    addedFunctions,
    removedFunctions,
    changedFunctions,
    hasBreakingChanges,
  };
}

export class ContractSpecRevalidatorService {
  private readonly store: ContractSpecValidationStore;
  private readonly expectedSpecs = new Map<ContractTargetName, ContractAbiSpec>();
  private readonly minFetchIntervalMs: number;

  constructor(options: {
    store?: ContractSpecValidationStore;
    minFetchIntervalMs?: number;
  } = {}) {
    this.store = options.store ?? new InMemoryContractSpecValidationStore();
    this.minFetchIntervalMs = options.minFetchIntervalMs ?? 30_000;
  }

  registerExpectedContractSpec(spec: ContractAbiSpec): void {
    this.expectedSpecs.set(spec.contractName, spec);
  }

  /**
   * Revalidates a contract's live on-chain spec against the expected ABI.
   * Respects `minFetchIntervalMs` throttling unless `forceOnUpgradeEvent` is true.
   * Preserves an existing `mismatch` hard block across restarts until a clean
   * revalidation succeeds or an operator explicitly overrides it.
   */
  async revalidateContract(
    contractName: ContractTargetName,
    fetchLiveSpec: () => Promise<ContractAbiSpec>,
    nowMs: number,
    options: { forceOnUpgradeEvent?: boolean } = {}
  ): Promise<PersistedContractValidationRecord> {
    const expected = this.expectedSpecs.get(contractName);
    if (!expected) {
      throw new Error(`No expected ABI spec registered for "${contractName}"`);
    }

    const existing = this.store.load(contractName);
    if (
      existing &&
      !options.forceOnUpgradeEvent &&
      nowMs - existing.lastCheckedAtMs < this.minFetchIntervalMs
    ) {
      return existing;
    }

    let liveSpec: ContractAbiSpec;
    try {
      liveSpec = await fetchLiveSpec();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Critical (#284): RPC unavailability must NOT be read as a mismatch;
      // However, if a mismatch hard block was already persisted, preserve the mismatch block!
      if (existing && existing.status === "mismatch") {
        const preserved: PersistedContractValidationRecord = {
          ...existing,
          lastCheckedAtMs: nowMs,
          lastError: `RPC error while mismatch block active: ${errMsg}`,
        };
        this.store.save(preserved);
        return preserved;
      }

      const unknownRecord: PersistedContractValidationRecord = {
        contractName,
        status: "unknown",
        canPublishOrSettle: false,
        circuitBreakerTripped: false,
        lastCheckedAtMs: nowMs,
        lastObservedWasmHash: existing?.lastObservedWasmHash,
        lastError: errMsg,
        highSeverityAlert: `[CONTRACT_SPEC_RPC_UNKNOWN] Failed to fetch live ABI for ${contractName}: ${errMsg}`,
      };
      this.store.save(unknownRecord);
      return unknownRecord;
    }

    const diffReport = diffContractSpecs(expected, liveSpec);
    if (diffReport.hasBreakingChanges) {
      const differingNames = [
        ...diffReport.removedFunctions,
        ...diffReport.changedFunctions.map((c) => c.functionName),
      ];
      const mismatchRecord: PersistedContractValidationRecord = {
        contractName,
        status: "mismatch",
        canPublishOrSettle: false,
        circuitBreakerTripped: true,
        lastCheckedAtMs: nowMs,
        lastObservedWasmHash: liveSpec.wasmHash,
        diffReport,
        highSeverityAlert: `[CONTRACT_ABI_MISMATCH] ${contractName} (${liveSpec.contractAddress}) breaking ABI change in functions: [${differingNames.join(", ")}]`,
      };
      this.store.save(mismatchRecord);
      return mismatchRecord;
    }

    const validRecord: PersistedContractValidationRecord = {
      contractName,
      status: "valid",
      canPublishOrSettle: true,
      circuitBreakerTripped: false,
      lastCheckedAtMs: nowMs,
      lastObservedWasmHash: liveSpec.wasmHash,
      diffReport,
    };
    this.store.save(validRecord);
    return validRecord;
  }

  /**
   * Explicit operator override to clear a mismatch block with an audited reason.
   */
  applyOperatorOverride(params: {
    contractName: ContractTargetName;
    actorId: string;
    reason: string;
    nowMs: number;
  }): PersistedContractValidationRecord {
    if (!params.actorId || params.actorId.trim() === "") {
      throw new Error("Operator override requires a non-empty actorId");
    }
    if (!params.reason || params.reason.trim() === "") {
      throw new Error("Operator override requires a non-empty reason");
    }
    const existing = this.store.load(params.contractName);
    if (!existing) {
      throw new Error(`No validation state found for "${params.contractName}"`);
    }

    const overridden: PersistedContractValidationRecord = {
      ...existing,
      status: "operator_overridden",
      canPublishOrSettle: true,
      circuitBreakerTripped: false,
      overrideActorId: params.actorId.trim(),
      overrideReason: params.reason.trim(),
      lastCheckedAtMs: params.nowMs,
    };
    this.store.save(overridden);
    return overridden;
  }

  /**
   * Gate checked by `oracleMonitor` and `claimProcessor` before publishing or settling.
   */
  canOperate(contractName: ContractTargetName): {
    allowed: boolean;
    status: SpecValidationStatus;
    diffReport?: ContractSpecDiffReport;
  } {
    const rec = this.store.load(contractName);
    if (!rec) {
      return { allowed: false, status: "unknown" };
    }
    return {
      allowed: rec.canPublishOrSettle,
      status: rec.status,
      diffReport: rec.diffReport,
    };
  }
}
