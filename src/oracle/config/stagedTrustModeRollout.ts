export type StagedOracleTrustMode =
  | "single_source"
  | "corroborated"
  | "decentralized";

export interface CoverageDeploymentPrerequisites {
  coverageType: string;
  configuredSourceCount: number;
  quorumMinimum: number;
  registeredExternalIdentities: number;
}

export interface ResolvedOracleTrustPolicy {
  coverageType: string;
  trustMode: StagedOracleTrustMode;
  quorumMinimum: number;
  requiresMultiSourceCorroboration: boolean;
  requiresSignedExternalIdentities: boolean;
}

const VALID_TRUST_MODES = new Set<StagedOracleTrustMode>([
  "single_source",
  "corroborated",
  "decentralized",
]);

export class StagedOracleTrustModeConfig {
  public static envSuffixToCoverageType(suffix: string): string {
    return suffix.trim().toLowerCase().replace(/_/g, "-");
  }

  public static coverageTypeToEnvKey(coverageType: string): string {
    const normalized = coverageType.trim().toUpperCase().replace(/-/g, "_");
    return `ORACLE_TRUST_MODE_${normalized}`;
  }

  public static resolveAndValidatePolicies(params: {
    env: Record<string, string | undefined>;
    catalogPrerequisites: CoverageDeploymentPrerequisites[];
  }): Map<string, ResolvedOracleTrustPolicy> {
    const prereqByCoverage = new Map<string, CoverageDeploymentPrerequisites>();
    for (const item of params.catalogPrerequisites) {
      prereqByCoverage.set(item.coverageType, item);
    }

    // 1. Reject unknown ORACLE_TRUST_MODE_<COVERAGE_TYPE> env keys
    for (const [envKey, rawVal] of Object.entries(params.env)) {
      if (!envKey.startsWith("ORACLE_TRUST_MODE_") || rawVal === undefined) {
        continue;
      }
      const suffix = envKey.slice("ORACLE_TRUST_MODE_".length);
      const coverageType = this.envSuffixToCoverageType(suffix);
      if (!prereqByCoverage.has(coverageType)) {
        throw new Error(
          `UNKNOWN_COVERAGE_TYPE_ENV: Environment variable ${envKey} references unknown coverage type "${coverageType}"`
        );
      }
    }

    const resolved = new Map<string, ResolvedOracleTrustPolicy>();

    for (const prereq of params.catalogPrerequisites) {
      const envKey = this.coverageTypeToEnvKey(prereq.coverageType);
      const rawMode = params.env[envKey]?.trim() || "single_source";

      if (!VALID_TRUST_MODES.has(rawMode as StagedOracleTrustMode)) {
        throw new Error(
          `INVALID_ORACLE_TRUST_MODE: ${envKey}="${rawMode}" must be one of single_source, corroborated, decentralized`
        );
      }

      const trustMode = rawMode as StagedOracleTrustMode;

      if (trustMode === "corroborated") {
        if (
          prereq.quorumMinimum < 2 ||
          prereq.configuredSourceCount < prereq.quorumMinimum
        ) {
          throw new Error(
            `PREREQUISITE_NOT_MET_CORROBORATED_QUORUM: Coverage "${prereq.coverageType}" in corroborated mode requires configuredSourceCount (${prereq.configuredSourceCount}) >= quorumMinimum (${prereq.quorumMinimum}) >= 2`
          );
        }
      }

      if (trustMode === "decentralized") {
        if (
          prereq.quorumMinimum < 2 ||
          prereq.registeredExternalIdentities < prereq.quorumMinimum
        ) {
          throw new Error(
            `PREREQUISITE_NOT_MET_DECENTRALIZED_IDENTITIES: Coverage "${prereq.coverageType}" in decentralized mode requires registeredExternalIdentities (${prereq.registeredExternalIdentities}) >= quorumMinimum (${prereq.quorumMinimum}) >= 2`
          );
        }
      }

      resolved.set(prereq.coverageType, {
        coverageType: prereq.coverageType,
        trustMode,
        quorumMinimum:
          trustMode === "single_source" ? 1 : Math.max(2, prereq.quorumMinimum),
        requiresMultiSourceCorroboration:
          trustMode === "corroborated" || trustMode === "decentralized",
        requiresSignedExternalIdentities: trustMode === "decentralized",
      });
    }

    return resolved;
  }

  public static canPublishDecisionUnderPolicy(params: {
    policy: ResolvedOracleTrustPolicy;
    operatorPaused: boolean;
    agreeingSourceCount: number;
    agreeingSignedExternalIdentities: number;
  }): {
    allowed: boolean;
    reasonCode:
      | "ALLOWED"
      | "OPERATOR_PAUSED"
      | "CORROBORATION_QUORUM_NOT_MET"
      | "DECENTRALIZED_IDENTITY_QUORUM_NOT_MET";
  } {
    if (params.operatorPaused) {
      return { allowed: false, reasonCode: "OPERATOR_PAUSED" };
    }

    if (params.policy.trustMode === "single_source") {
      return params.agreeingSourceCount >= 1
        ? { allowed: true, reasonCode: "ALLOWED" }
        : { allowed: false, reasonCode: "CORROBORATION_QUORUM_NOT_MET" };
    }

    if (params.agreeingSourceCount < params.policy.quorumMinimum) {
      return { allowed: false, reasonCode: "CORROBORATION_QUORUM_NOT_MET" };
    }

    if (
      params.policy.trustMode === "decentralized" &&
      params.agreeingSignedExternalIdentities < params.policy.quorumMinimum
    ) {
      return {
        allowed: false,
        reasonCode: "DECENTRALIZED_IDENTITY_QUORUM_NOT_MET",
      };
    }

    return { allowed: true, reasonCode: "ALLOWED" };
  }
}
