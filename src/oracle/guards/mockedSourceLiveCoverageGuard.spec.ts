import { test } from "node:test";
import assert from "node:assert/strict";
import { validateNoMockedSourcesOnLiveCoverages } from "./mockedSourceLiveCoverageGuard.ts";

test("validateNoMockedSourcesOnLiveCoverages rejects mocked sources or degraded trust modes on live coverages and refuses mainnet overrides", () => {
  // 1. Fully live, corroborated configuration passes
  const clean = validateNoMockedSourcesOnLiveCoverages({
    network: "mainnet",
    entries: [
      {
        coverageType: "USDC-DEPEG",
        enabled: true,
        isLiveCoverage: true,
        minTrustMode: "corroborated",
        configuredTrustMode: "corroborated",
        configuredSources: [
          { sourceId: "coingecko", mocked: false },
          { sourceId: "defillama", mocked: false },
        ],
      },
    ],
  });
  assert.equal(clean.passed, true);

  // 2. Mocked source + trust mode below minimum rejected without override
  const rejected = validateNoMockedSourcesOnLiveCoverages({
    network: "testnet",
    entries: [
      {
        coverageType: "LIQUIDATION-SHIELD",
        enabled: true,
        isLiveCoverage: true,
        minTrustMode: "corroborated",
        configuredTrustMode: "single",
        configuredSources: [{ sourceId: "mock-liquidation", mocked: true }],
      },
    ],
  });
  assert.equal(rejected.passed, false);
  assert.ok(
    rejected.violations.some((v) =>
      v.includes("MOCKED_SOURCE_ON_LIVE_COVERAGE")
    )
  );
  assert.ok(
    rejected.violations.some((v) => v.includes("TRUST_MODE_BELOW_MINIMUM"))
  );

  // 3. Dev override allowed on testnet (logs warning), refused on mainnet
  const devAllowed = validateNoMockedSourcesOnLiveCoverages({
    network: "testnet",
    allowDevMockOverride: true,
    entries: [
      {
        coverageType: "LIQUIDATION-SHIELD",
        enabled: true,
        isLiveCoverage: true,
        minTrustMode: "corroborated",
        configuredTrustMode: "single",
        configuredSources: [{ sourceId: "mock-liquidation", mocked: true }],
      },
    ],
  });
  assert.equal(devAllowed.passed, true);
  assert.equal(devAllowed.warnings.length, 2);

  const mainnetRefused = validateNoMockedSourcesOnLiveCoverages({
    network: "mainnet",
    allowDevMockOverride: true,
    entries: [
      {
        coverageType: "LIQUIDATION-SHIELD",
        enabled: true,
        isLiveCoverage: true,
        minTrustMode: "corroborated",
        configuredTrustMode: "single",
        configuredSources: [{ sourceId: "mock-liquidation", mocked: true }],
      },
    ],
  });
  assert.equal(mainnetRefused.passed, false);
  assert.ok(
    mainnetRefused.violations.some((v) =>
      v.includes("MAINNET_MOCK_OVERRIDE_REFUSED")
    )
  );
});
