/**
 * Consumer-Driven Contract Specifications and Producer Verifier
 * Across Backend, Contracts, and Frontend (Issue #292)
 *
 * Pins the shapes, types, units, and enum domains of oracle trust payloads
 * (`ConsensusDecision`, `ProvenanceAttestation`, `TrustStatusResponse`, and
 * `OnChainEncodedReading`) consumed by `refract-frontend` and `refract-contracts`.
 * Additive fields pass without ceremony; breaking changes fail with named-field errors.
 */

export type ConsumerName = "refract-frontend" | "refract-contracts";

export type ContractFieldType =
  | "string"
  | "number"
  | "boolean"
  | "bigint_string"
  | "string_array"
  | "object";

export interface ConsumerFieldExpectation {
  fieldPath: string;
  expectedType: ContractFieldType;
  required: boolean;
  /** Optional unit or scale invariant (e.g. "stroops_1e7" or "bps_1e4") */
  expectedUnit?: string;
  /** Optional allowed enum values when expectedType === "string" */
  allowedEnumValues?: readonly string[];
}

export interface ConsumerContractSpec {
  contractId: string;
  consumer: ConsumerName;
  interfaceName:
    | "ConsensusDecision"
    | "ProvenanceAttestation"
    | "TrustStatusResponse"
    | "OnChainEncodedReading";
  contractVersion: number;
  fields: ConsumerFieldExpectation[];
}

export interface ContractViolation {
  fieldPath: string;
  kind:
    | "missing_required_field"
    | "type_mismatch"
    | "enum_violation"
    | "unit_mismatch"
    | "version_mismatch";
  message: string;
}

export interface ContractVerificationResult {
  contractId: string;
  consumer: ConsumerName;
  interfaceName: string;
  contractVersion: number;
  passed: boolean;
  violations: ContractViolation[];
  additiveFields: string[];
}

export const CONSUMER_CONTRACT_SPECS: readonly ConsumerContractSpec[] = [
  {
    contractId: "frontend-consensus-decision-v1",
    consumer: "refract-frontend",
    interfaceName: "ConsensusDecision",
    contractVersion: 1,
    fields: [
      { fieldPath: "decisionId", expectedType: "string", required: true },
      { fieldPath: "feedId", expectedType: "string", required: true },
      { fieldPath: "roundNumber", expectedType: "number", required: true },
      {
        fieldPath: "consensusValueStroops",
        expectedType: "bigint_string",
        required: true,
        expectedUnit: "stroops_1e7",
      },
      {
        fieldPath: "unit",
        expectedType: "string",
        required: true,
        expectedUnit: "stroops_1e7",
      },
      { fieldPath: "confidenceScoreBps", expectedType: "number", required: true },
      {
        fieldPath: "trustMode",
        expectedType: "string",
        required: true,
        allowedEnumValues: ["healthy", "degraded", "paused", "canary"],
      },
      { fieldPath: "decidedAtMs", expectedType: "number", required: true },
      { fieldPath: "contributingSources", expectedType: "string_array", required: true },
    ],
  },
  {
    contractId: "frontend-provenance-attestation-v1",
    consumer: "refract-frontend",
    interfaceName: "ProvenanceAttestation",
    contractVersion: 1,
    fields: [
      { fieldPath: "attestationId", expectedType: "string", required: true },
      { fieldPath: "decisionId", expectedType: "string", required: true },
      { fieldPath: "merkleRootHex", expectedType: "string", required: true },
      { fieldPath: "quorumPolicyVersion", expectedType: "number", required: true },
      { fieldPath: "operatorSignatures", expectedType: "string_array", required: true },
    ],
  },
  {
    contractId: "frontend-trust-status-v1",
    consumer: "refract-frontend",
    interfaceName: "TrustStatusResponse",
    contractVersion: 1,
    fields: [
      { fieldPath: "feedId", expectedType: "string", required: true },
      {
        fieldPath: "circuitBreakerState",
        expectedType: "string",
        required: true,
        allowedEnumValues: ["closed", "open", "half_open_canary"],
      },
      { fieldPath: "pausedOnChain", expectedType: "boolean", required: true },
      { fieldPath: "activeSourceCount", expectedType: "number", required: true },
      { fieldPath: "lastPublishedAtMs", expectedType: "number", required: true },
    ],
  },
  {
    contractId: "contracts-onchain-encoded-reading-v1",
    consumer: "refract-contracts",
    interfaceName: "OnChainEncodedReading",
    contractVersion: 1,
    fields: [
      { fieldPath: "contractMethod", expectedType: "string", required: true, allowedEnumValues: ["publish_reading"] },
      { fieldPath: "feedSymbol", expectedType: "string", required: true },
      { fieldPath: "roundId", expectedType: "number", required: true },
      {
        fieldPath: "valueI128Stroops",
        expectedType: "bigint_string",
        required: true,
        expectedUnit: "stroops_1e7",
      },
      { fieldPath: "decimals", expectedType: "number", required: true },
      { fieldPath: "timestampSec", expectedType: "number", required: true },
      { fieldPath: "provenanceHashHex", expectedType: "string", required: true },
    ],
  },
];

function matchesFieldType(value: unknown, expectedType: ContractFieldType): boolean {
  switch (expectedType) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "bigint_string":
      return typeof value === "string" && /^-?\d+$/.test(value);
    case "string_array":
      return Array.isArray(value) && value.every((item) => typeof item === "string");
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

/**
 * Verifies a producer payload against a consumer-driven contract specification.
 * Additive fields not declared in the consumer spec are recorded in `additiveFields`
 * and allowed without failing verification.
 */
export function verifyProducerPayloadAgainstContract(
  spec: ConsumerContractSpec,
  producerPayload: Record<string, unknown>,
  producerContractVersion: number = spec.contractVersion
): ContractVerificationResult {
  const violations: ContractViolation[] = [];

  if (producerContractVersion !== spec.contractVersion) {
    violations.push({
      fieldPath: "$contractVersion",
      kind: "version_mismatch",
      message: `Contract "${spec.contractId}" (${spec.consumer}) expects version ${spec.contractVersion} but producer emitted version ${producerContractVersion} without consumer opt-in`,
    });
  }

  const expectedFieldNames = new Set(spec.fields.map((f) => f.fieldPath));
  const actualKeys = Object.keys(producerPayload);

  for (const field of spec.fields) {
    const val = producerPayload[field.fieldPath];
    if (val === undefined || val === null) {
      if (field.required) {
        violations.push({
          fieldPath: field.fieldPath,
          kind: "missing_required_field",
          message: `Contract "${spec.contractId}" (${spec.consumer} -> ${spec.interfaceName}): missing required field "${field.fieldPath}"`,
        });
      }
      continue;
    }

    if (!matchesFieldType(val, field.expectedType)) {
      violations.push({
        fieldPath: field.fieldPath,
        kind: "type_mismatch",
        message: `Contract "${spec.contractId}" (${spec.consumer} -> ${spec.interfaceName}): field "${field.fieldPath}" expected type "${field.expectedType}" but received ${typeof val} (${JSON.stringify(val)})`,
      });
      continue;
    }

    if (
      field.allowedEnumValues &&
      typeof val === "string" &&
      !field.allowedEnumValues.includes(val)
    ) {
      violations.push({
        fieldPath: field.fieldPath,
        kind: "enum_violation",
        message: `Contract "${spec.contractId}" (${spec.consumer} -> ${spec.interfaceName}): field "${field.fieldPath}" value "${val}" is not in allowed enum [${field.allowedEnumValues.join(", ")}]`,
      });
    }

    if (
      field.fieldPath === "unit" &&
      field.expectedUnit &&
      typeof val === "string" &&
      val !== field.expectedUnit
    ) {
      violations.push({
        fieldPath: field.fieldPath,
        kind: "unit_mismatch",
        message: `Contract "${spec.contractId}" (${spec.consumer} -> ${spec.interfaceName}): field "${field.fieldPath}" expected unit "${field.expectedUnit}" but received "${val}"`,
      });
    }
  }

  const additiveFields = actualKeys.filter((k) => !expectedFieldNames.has(k));

  return {
    contractId: spec.contractId,
    consumer: spec.consumer,
    interfaceName: spec.interfaceName,
    contractVersion: spec.contractVersion,
    passed: violations.length === 0,
    violations,
    additiveFields,
  };
}

/**
 * Throws a readable CI failure error if any violation is present.
 */
export function assertProducerMatchesConsumerContract(
  spec: ConsumerContractSpec,
  producerPayload: Record<string, unknown>,
  producerContractVersion: number = spec.contractVersion
): ContractVerificationResult {
  const result = verifyProducerPayloadAgainstContract(
    spec,
    producerPayload,
    producerContractVersion
  );
  if (!result.passed) {
    const details = result.violations.map((v) => `  - [${v.kind}] ${v.message}`).join("\n");
    throw new Error(
      `Consumer contract verification failed for ${spec.contractId}:\n${details}`
    );
  }
  return result;
}
