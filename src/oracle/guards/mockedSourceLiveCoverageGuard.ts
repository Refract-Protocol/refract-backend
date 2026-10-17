export type CoverageTrustTier = "single" | "corroborated" | "decentralized";

export interface CoverageGuardCatalogEntry {
  coverageType: string;
  enabled: boolean;
  isLiveCoverage: boolean;
  minTrustMode: CoverageTrustTier;
  configuredTrustMode: CoverageTrustTier;
  configuredSources: Array<{
    sourceId: string;
    mocked: boolean;
  }>;
}

export interface MockSourceGuardResult {
  passed: boolean;
  violations: string[];
  warnings: string[];
}

const TRUST_MODE_RANK: Record<CoverageTrustTier, number> = {
  single: 1,
  corroborated: 2,
  decentralized: 3,
};

export function validateNoMockedSourcesOnLiveCoverages(params: {
  network: "mainnet" | "testnet" | "futurenet" | "standalone";
  allowDevMockOverride?: boolean;
  entries: CoverageGuardCatalogEntry[];
}): MockSourceGuardResult {
  const violations: string[] = [];
  const warnings: string[] = [];

  if (params.network === "mainnet" && params.allowDevMockOverride) {
    violations.push(
      "MAINNET_MOCK_OVERRIDE_REFUSED: Development mock override is strictly forbidden when STELLAR_NETWORK=mainnet"
    );
  }

  const effectiveDevOverride =
    Boolean(params.allowDevMockOverride) && params.network !== "mainnet";

  for (const entry of params.entries) {
    if (!entry.enabled || !entry.isLiveCoverage) {
      continue;
    }

    const mockedSources = entry.configuredSources.filter((s) => s.mocked);
    if (mockedSources.length > 0) {
      const names = mockedSources.map((s) => s.sourceId).join(", ");
      if (effectiveDevOverride) {
        warnings.push(
          `DEV_OVERRIDE_ACTIVE: Live coverage '${entry.coverageType}' is using mocked source(s) [${names}] on '${params.network}'`
        );
      } else {
        violations.push(
          `MOCKED_SOURCE_ON_LIVE_COVERAGE: Live coverage '${entry.coverageType}' cannot be served by mocked source(s): ${names}`
        );
      }
    }

    if (
      TRUST_MODE_RANK[entry.configuredTrustMode] <
      TRUST_MODE_RANK[entry.minTrustMode]
    ) {
      if (effectiveDevOverride) {
        warnings.push(
          `DEV_OVERRIDE_ACTIVE: Coverage '${entry.coverageType}' trust mode '${entry.configuredTrustMode}' is below minimum '${entry.minTrustMode}'`
        );
      } else {
        violations.push(
          `TRUST_MODE_BELOW_MINIMUM: Coverage '${entry.coverageType}' configured as '${entry.configuredTrustMode}' but requires at least '${entry.minTrustMode}'`
        );
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    warnings,
  };
}
