import { createHash } from "node:crypto";

export interface SorobanFunctionArgSpec {
  name: string;
  type: string;
}

export interface SorobanFunctionSpec {
  name: string;
  inputs: SorobanFunctionArgSpec[];
  output: string;
}

export const EXPECTED_REFRACT_ORACLE_SPEC: readonly SorobanFunctionSpec[] = [
  {
    name: "publish_reading",
    inputs: [
      { name: "feed_id", type: "Symbol" },
      { name: "value", type: "I128" },
      { name: "observed_at", type: "U64" },
      { name: "provenance_hash", type: "BytesN<32>" },
    ],
    output: "Void",
  },
  {
    name: "get_latest_reading",
    inputs: [{ name: "feed_id", type: "Symbol" }],
    output: "Option<OracleReading>",
  },
  {
    name: "get_quorum_config",
    inputs: [{ name: "feed_id", type: "Symbol" }],
    output: "QuorumConfig",
  },
];

export interface OracleSpecValidationResult {
  valid: boolean;
  skipped: boolean;
  warning: string | null;
  contractId: string;
  network: string;
  specHash: string | null;
  mismatches: string[];
}

export async function validateOracleContractSpecOnStartup(params: {
  network: string;
  contractId: string;
  skipValidation?: boolean;
  rpcTimeoutMs?: number;
  fetchRemoteSpec: (
    contractId: string,
    timeoutMs: number
  ) => Promise<SorobanFunctionSpec[]>;
}): Promise<OracleSpecValidationResult> {
  if (params.skipValidation) {
    return {
      valid: true,
      skipped: true,
      warning: `WARNING: Skipping RefractOracle startup spec validation for contract '${params.contractId}' on network '${params.network}' (SKIP_ORACLE_SPEC_VALIDATION=true)`,
      contractId: params.contractId,
      network: params.network,
      specHash: null,
      mismatches: [],
    };
  }

  const timeoutMs = params.rpcTimeoutMs ?? 5_000;
  let remoteSpecs: SorobanFunctionSpec[];

  try {
    remoteSpecs = await params.fetchRemoteSpec(params.contractId, timeoutMs);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "RPC_UNAVAILABLE";
    return {
      valid: false,
      skipped: false,
      warning: null,
      contractId: params.contractId,
      network: params.network,
      specHash: null,
      mismatches: [
        `RPC_TIMEOUT_OR_UNAVAILABLE: Failed to fetch RefractOracle spec for '${params.contractId}' on '${params.network}': ${reason}`,
      ],
    };
  }

  const mismatches: string[] = [];
  const byName = new Map<string, SorobanFunctionSpec>(
    remoteSpecs.map((fn) => [fn.name, fn])
  );

  for (const expected of EXPECTED_REFRACT_ORACLE_SPEC) {
    const actual = byName.get(expected.name);
    if (!actual) {
      mismatches.push(
        `MISSING_FUNCTION: RefractOracle contract '${params.contractId}' is missing entry point '${expected.name}'`
      );
      continue;
    }

    if (actual.inputs.length !== expected.inputs.length) {
      mismatches.push(
        `ARGUMENT_COUNT_MISMATCH: Function '${expected.name}' expected ${expected.inputs.length} arguments but contract exposes ${actual.inputs.length}`
      );
    } else {
      for (let i = 0; i < expected.inputs.length; i++) {
        const expArg = expected.inputs[i];
        const actArg = actual.inputs[i];
        if (expArg.name !== actArg.name || expArg.type !== actArg.type) {
          mismatches.push(
            `ARGUMENT_MISMATCH: Function '${expected.name}' arg[${i}] expected '${expArg.name}: ${expArg.type}' but found '${actArg.name}: ${actArg.type}'`
          );
        }
      }
    }

    if (actual.output !== expected.output) {
      mismatches.push(
        `RETURN_TYPE_MISMATCH: Function '${expected.name}' expected return type '${expected.output}' but found '${actual.output}'`
      );
    }
  }

  const canonicalSpecJson = JSON.stringify(
    [...remoteSpecs].sort((a, b) => a.name.localeCompare(b.name))
  );
  const specHash = createHash("sha256")
    .update(canonicalSpecJson)
    .digest("hex");

  return {
    valid: mismatches.length === 0,
    skipped: false,
    warning: null,
    contractId: params.contractId,
    network: params.network,
    specHash: mismatches.length === 0 ? specHash : null,
    mismatches,
  };
}
