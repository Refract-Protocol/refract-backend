import { z } from "zod";
import { COVERAGE_CATALOG, CoverageType } from "../common/coverage-catalog";

/**
 * Oracle trust modes, ordered from weakest to strongest.
 *
 * - `single_source`: today's behaviour. One reader decides; the existing
 *   pause fallback applies. This is the default for every coverage type.
 * - `corroborated`: a payout-triggering value must be reported by at least
 *   `quorumMin` distinct configured sources.
 * - `decentralized`: as `corroborated`, but the sources must be distinct
 *   registered provider identities.
 */
export const ORACLE_TRUST_MODES = ["single_source", "corroborated", "decentralized"] as const;
export type OracleTrustMode = (typeof ORACLE_TRUST_MODES)[number];

/** Resolved, per-coverage trust policy. Downstream code reads this, never raw env. */
export interface OraclePolicy {
  coverageType: CoverageType;
  mode: OracleTrustMode;
  /** Distinct agreeing sources required before a value may be acted on. */
  quorumMin: number;
  /** Distinct configured sources (registered providers for `decentralized`). */
  sources: string[];
}

export type OraclePolicyMap = Record<CoverageType, OraclePolicy>;

/** Injection token for the resolved policy map. */
export const ORACLE_TRUST_POLICIES = Symbol("ORACLE_TRUST_POLICIES");

const TRUST_MODE_PREFIX = "ORACLE_TRUST_MODE_";
const SOURCES_PREFIX = "ORACLE_SOURCES_";
const QUORUM_MIN_KEY = "ORACLE_QUORUM_MIN";
const DEFAULT_QUORUM_MIN = 2;

/** `StablecoinDepeg` -> `STABLECOIN_DEPEG`, the suffix used in env var names. */
const toEnvSuffix = (coverageType: string): string =>
  coverageType.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();

const COVERAGE_TYPES = Object.keys(COVERAGE_CATALOG) as CoverageType[];
const COVERAGE_BY_SUFFIX = new Map<string, CoverageType>(
  COVERAGE_TYPES.map((coverageType) => [toEnvSuffix(coverageType), coverageType]),
);

const trustModeSchema = z.enum(ORACLE_TRUST_MODES);

const quorumMinSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.coerce.number().int().min(2).optional(),
);

/**
 * Resolve `ORACLE_TRUST_MODE_<COVERAGE>`, `ORACLE_SOURCES_<COVERAGE>` and
 * `ORACLE_QUORUM_MIN` into one policy per coverage type.
 *
 * Fails fast with a single aggregated error listing every problem: unknown
 * coverage types in variable names, invalid modes or quorum values, and
 * corroborated/decentralized modes whose configured sources cannot meet the
 * quorum minimum (including `decentralized` with zero registered providers).
 * Coverage types without a trust-mode variable stay `single_source`, so
 * existing deployments are unaffected.
 */
export function resolveOraclePolicies(env: NodeJS.ProcessEnv = process.env): OraclePolicyMap {
  const issues: string[] = [];

  for (const key of Object.keys(env)) {
    for (const prefix of [TRUST_MODE_PREFIX, SOURCES_PREFIX]) {
      if (key.startsWith(prefix) && !COVERAGE_BY_SUFFIX.has(key.slice(prefix.length))) {
        issues.push(
          `${key}: unknown coverage type "${key.slice(prefix.length)}" (expected one of ${[...COVERAGE_BY_SUFFIX.keys()].join(", ")})`,
        );
      }
    }
  }

  const quorum = quorumMinSchema.safeParse(env[QUORUM_MIN_KEY]);
  if (!quorum.success) {
    issues.push(`${QUORUM_MIN_KEY} must be an integer >= 2 (received "${env[QUORUM_MIN_KEY]}")`);
  }
  const quorumMin = (quorum.success && quorum.data) || DEFAULT_QUORUM_MIN;

  const policies = {} as OraclePolicyMap;
  for (const coverageType of COVERAGE_TYPES) {
    const suffix = toEnvSuffix(coverageType);
    const modeKey = `${TRUST_MODE_PREFIX}${suffix}`;
    const sourcesKey = `${SOURCES_PREFIX}${suffix}`;

    const rawMode = env[modeKey] || undefined;
    const mode = trustModeSchema.optional().safeParse(rawMode);
    if (!mode.success) {
      issues.push(`${modeKey} must be one of ${ORACLE_TRUST_MODES.join(", ")} (received "${rawMode}")`);
    }
    const resolvedMode: OracleTrustMode = (mode.success && mode.data) || "single_source";

    const sources = [
      ...new Set(
        (env[sourcesKey] ?? "")
          .split(",")
          .map((source) => source.trim())
          .filter((source) => source.length > 0),
      ),
    ];

    if (resolvedMode !== "single_source" && sources.length < quorumMin) {
      const noun = resolvedMode === "decentralized" ? "registered providers" : "sources";
      issues.push(
        `${modeKey}=${resolvedMode} requires at least ${quorumMin} distinct ${noun} in ${sourcesKey} (found ${sources.length})`,
      );
    }

    policies[coverageType] = { coverageType, mode: resolvedMode, quorumMin, sources };
  }

  if (issues.length > 0) {
    throw new Error(`Invalid oracle trust-mode configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
  }

  return policies;
}

/**
 * Whether the agreeing sources satisfy the policy. `single_source` always
 * passes; the other modes need `quorumMin` distinct configured sources, so
 * unregistered or duplicate reporters never count toward quorum.
 */
export function meetsTrustPolicy(policy: OraclePolicy, agreeingSources: readonly string[]): boolean {
  if (policy.mode === "single_source") {
    return true;
  }
  const counted = new Set(agreeingSources.filter((source) => policy.sources.includes(source)));
  return counted.size >= policy.quorumMin;
}

/** Nest provider factory: resolves the policy map from the process environment. */
export const oracleTrustPoliciesProvider = {
  provide: ORACLE_TRUST_POLICIES,
  useFactory: (): OraclePolicyMap => resolveOraclePolicies(process.env),
};
