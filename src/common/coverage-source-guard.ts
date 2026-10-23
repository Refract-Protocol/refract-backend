import { Logger } from "@nestjs/common";
import { COVERAGE_PRODUCTS, CoverageProduct } from "./coverage-catalog";
import {
  ORACLE_SOURCE_CAPABILITIES,
  ORACLE_TRUST_MODES,
  OracleSourceCapability,
} from "../oracle/oracle-encoding";

/**
 * Development-only escape hatch: lets a non-mainnet process run live coverage
 * types on mocked or under-trusted sources. Refused outright on mainnet.
 */
export const MOCKED_SOURCE_OVERRIDE_ENV = "ALLOW_MOCKED_COVERAGE_SOURCES";

const MAINNET_NETWORKS = new Set(["mainnet", "public"]);
const TRUTHY = new Set(["true", "1", "yes", "on"]);

export interface CoverageSourceGuardInput {
  products: readonly CoverageProduct[];
  sources: Readonly<Record<string, OracleSourceCapability>>;
  network: string;
  overrideRequested: boolean;
}

export interface CoverageSourceGuardResult {
  /** Blocking violations. Empty when startup may proceed. */
  violations: string[];
  /** Violations waived by the override. Logged loudly, never blocking. */
  waived: string[];
}

/**
 * Pure rule check: every enabled (`live`) coverage product must be backed by a
 * source whose kind matches the declared `sourceKind`, that is not `mocked`,
 * and whose trust mode meets the product's `minTrustMode`. Violations name the
 * coverage type, the source, and the required trust mode.
 */
export function evaluateCoverageSourceGuard(input: CoverageSourceGuardInput): CoverageSourceGuardResult {
  const isMainnet = MAINNET_NETWORKS.has(input.network.trim().toLowerCase());
  const findings: string[] = [];

  for (const product of input.products) {
    if (product.status !== "live") continue;

    const source = input.sources[product.id];
    if (!source) {
      findings.push(`${product.id} has no wired source; required minimum trust mode is "${product.minTrustMode}"`);
      continue;
    }
    if (source.kind !== product.sourceKind) {
      findings.push(
        `${product.id} declares sourceKind "${product.sourceKind}" but source "${source.name}" is "${source.kind}"`,
      );
    }
    if (source.kind === "mocked") {
      findings.push(
        `${product.id} is enabled but served by mocked source "${source.name}"; required minimum trust mode is "${product.minTrustMode}"`,
      );
    } else if (ORACLE_TRUST_MODES.indexOf(source.trustMode) < ORACLE_TRUST_MODES.indexOf(product.minTrustMode)) {
      findings.push(
        `${product.id} source "${source.name}" has trust mode "${source.trustMode}", below required minimum "${product.minTrustMode}"`,
      );
    }
  }

  if (isMainnet && input.overrideRequested) {
    return {
      violations: [`${MOCKED_SOURCE_OVERRIDE_ENV} is refused on mainnet (STELLAR_NETWORK=${input.network})`, ...findings],
      waived: [],
    };
  }
  if (input.overrideRequested) {
    return { violations: [], waived: findings };
  }
  return { violations: findings, waived: [] };
}

/**
 * Startup gate wired into bootstrap. Reads the environment, throws when any
 * violation is not waived, and logs every waived violation as a warning.
 */
export function assertCoverageSourceGuard(env: NodeJS.ProcessEnv = process.env): void {
  const logger = new Logger("CoverageSourceGuard");
  const result = evaluateCoverageSourceGuard({
    products: COVERAGE_PRODUCTS,
    sources: ORACLE_SOURCE_CAPABILITIES,
    network: env.STELLAR_NETWORK ?? "testnet",
    overrideRequested: TRUTHY.has((env[MOCKED_SOURCE_OVERRIDE_ENV] ?? "").trim().toLowerCase()),
  });

  if (result.violations.length > 0) {
    throw new Error(`Coverage source guard failed: ${result.violations.join("; ")}`);
  }
  for (const finding of result.waived) {
    logger.warn(`DEV OVERRIDE ACTIVE (${MOCKED_SOURCE_OVERRIDE_ENV}): ${finding}`);
  }
}
