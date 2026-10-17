/**
 * PII Redaction, Data Classification, and License/Attribution Enforcement
 * for Captured Provider Payloads (Issue #240)
 *
 * Applies deterministic, pure PII redaction between adapter output and evidence
 * capture so content hashes remain reproducible without storing PII, fails closed
 * on unclassified sources, preserves numerical consensus inputs intact, and enforces
 * redistribution and attribution constraints on external surfaces.
 */

import { createHash } from "node:crypto";

export type SourceDataClassification =
  | "public_redistributable"
  | "internal_evidence_only"
  | "restricted_pii";

export interface SourceClassificationPolicy {
  sourceId: string;
  dataClassification: SourceDataClassification;
  requiresAttribution: boolean;
  attributionText?: string;
  allowRawExternalExposure: boolean;
  /** Top-level or dot-separated field names that may contain PII and must be stripped/redacted */
  piiFieldNames: string[];
}

export const DEFAULT_PII_FIELD_NAMES: readonly string[] = [
  "passengerName",
  "passengerNames",
  "passportNumber",
  "bookingReference",
  "pnrCode",
  "customerEmail",
  "email",
  "phoneNumber",
  "ipAddress",
  "accountHolderName",
  "walletOwnerPii",
];

export interface CapturedEvidencePayloadRecord {
  evidenceId: string;
  sourceId: string;
  feedId: string;
  dataClassification: SourceDataClassification;
  sanitizedPayload: Record<string, unknown>;
  /** Names of fields redacted (never contains the raw redacted values) */
  redactedFieldNames: string[];
  attributionText?: string;
  contentHashHex: string;
  capturedAtMs: number;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const entries = sortedKeys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`
  );
  return `{${entries.join(",")}}`;
}

function deepRedactObject(
  input: Record<string, unknown>,
  piiKeySet: ReadonlySet<string>,
  redactedPaths: string[],
  prefix = ""
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    const val = input[key];

    if (piiKeySet.has(key) || piiKeySet.has(fullPath)) {
      redactedPaths.push(fullPath);
      out[key] = "[REDACTED_PII]";
      continue;
    }

    if (Array.isArray(val)) {
      out[key] = val.map((item, idx) => {
        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
          return deepRedactObject(
            item as Record<string, unknown>,
            piiKeySet,
            redactedPaths,
            `${fullPath}[${idx}]`
          );
        }
        return item;
      });
    } else if (typeof val === "object" && val !== null) {
      out[key] = deepRedactObject(
        val as Record<string, unknown>,
        piiKeySet,
        redactedPaths,
        fullPath
      );
    } else {
      out[key] = val;
    }
  }
  return out;
}

export class ProviderPayloadClassifierAndRedactor {
  private readonly policies = new Map<string, SourceClassificationPolicy>();

  registerSourcePolicy(policy: SourceClassificationPolicy): void {
    if (!policy.sourceId || policy.sourceId.trim() === "") {
      throw new Error("sourceId must be non-empty");
    }
    if (
      policy.requiresAttribution &&
      (!policy.attributionText || policy.attributionText.trim() === "")
    ) {
      throw new Error(
        `Source "${policy.sourceId}" requiresAttribution=true but attributionText is empty`
      );
    }
    if (
      policy.dataClassification !== "public_redistributable" &&
      policy.allowRawExternalExposure
    ) {
      throw new Error(
        `Source "${policy.sourceId}" with classification "${policy.dataClassification}" cannot set allowRawExternalExposure=true`
      );
    }

    this.policies.set(policy.sourceId, {
      ...policy,
      piiFieldNames: [
        ...new Set([...DEFAULT_PII_FIELD_NAMES, ...policy.piiFieldNames]),
      ],
    });
  }

  /**
   * Pure deterministic redaction and classification gate applied prior to
   * evidence persistence. Fails closed if `sourceId` lacks a registered classification policy.
   */
  captureAndRedactPayload(params: {
    sourceId: string;
    feedId: string;
    rawPayload: Record<string, unknown>;
    capturedAtMs: number;
  }): CapturedEvidencePayloadRecord {
    const policy = this.policies.get(params.sourceId);
    if (!policy) {
      throw new Error(
        `[UNCLASSIFIED_SOURCE_BLOCKED] Refusing to persist or expose payload from unclassified source "${params.sourceId}"`
      );
    }

    const piiSet = new Set(policy.piiFieldNames);
    const redactedFieldNames: string[] = [];
    const sanitizedPayload = deepRedactObject(
      params.rawPayload,
      piiSet,
      redactedFieldNames
    );

    const canonicalJson = stableStringify({
      sourceId: params.sourceId,
      feedId: params.feedId,
      dataClassification: policy.dataClassification,
      sanitizedPayload,
    });
    const contentHashHex = createHash("sha256")
      .update(canonicalJson)
      .digest("hex");

    return {
      evidenceId: `ev_${contentHashHex.slice(0, 24)}`,
      sourceId: params.sourceId,
      feedId: params.feedId,
      dataClassification: policy.dataClassification,
      sanitizedPayload,
      redactedFieldNames,
      attributionText: policy.requiresAttribution
        ? policy.attributionText
        : undefined,
      contentHashHex,
      capturedAtMs: params.capturedAtMs,
    };
  }

  /**
   * Renders a captured evidence record for public/external API exposure, enforcing
   * license redistribution restrictions and mandatory attribution metadata.
   */
  renderForExternalExposure(record: CapturedEvidencePayloadRecord): {
    allowed: boolean;
    reason?: "redistribution_prohibited_by_license" | "unclassified_source";
    exposedPayload?: Record<string, unknown>;
    attribution?: string;
  } {
    const policy = this.policies.get(record.sourceId);
    if (!policy) {
      return { allowed: false, reason: "unclassified_source" };
    }

    if (!policy.allowRawExternalExposure) {
      return {
        allowed: false,
        reason: "redistribution_prohibited_by_license",
        attribution: policy.attributionText,
      };
    }

    return {
      allowed: true,
      exposedPayload: record.sanitizedPayload,
      attribution: policy.attributionText,
    };
  }

  /**
   * Verification scanner: audits stored evidence rows and fails if any row comes
   * from an unclassified source, misses required attribution, or contains unredacted PII.
   */
  verifyStoredEvidenceCompliance(
    storedRecords: readonly CapturedEvidencePayloadRecord[]
  ): { compliant: boolean; violations: string[] } {
    const violations: string[] = [];

    for (const rec of storedRecords) {
      const policy = this.policies.get(rec.sourceId);
      if (!policy) {
        violations.push(
          `Evidence "${rec.evidenceId}" references unclassified source "${rec.sourceId}"`
        );
        continue;
      }

      if (policy.requiresAttribution && !rec.attributionText) {
        violations.push(
          `Evidence "${rec.evidenceId}" from source "${rec.sourceId}" is missing required license attribution`
        );
      }

      // Verify no raw PII value survived in sanitizedPayload
      const piiSet = new Set(policy.piiFieldNames);
      for (const [k, v] of Object.entries(rec.sanitizedPayload)) {
        if (piiSet.has(k) && v !== "[REDACTED_PII]") {
          violations.push(
            `Evidence "${rec.evidenceId}" contains unredacted PII field "${k}"`
          );
        }
      }
    }

    return {
      compliant: violations.length === 0,
      violations,
    };
  }
}
