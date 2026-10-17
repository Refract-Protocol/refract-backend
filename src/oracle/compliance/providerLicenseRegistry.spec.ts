import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderLicenseRegistry } from "./providerLicenseRegistry.ts";

test("ProviderLicenseRegistry tracks permitted uses, warns on approaching expiry, and suspends expired sources", () => {
  const registry = new ProviderLicenseRegistry(30);
  const dayMs = 24 * 60 * 60 * 1_000;

  registry.registerLicense({
    sourceId: "commercial-weather",
    licenseType: "commercial",
    permitRawStorage: false,
    permitOnChainDerivedPublication: true,
    permitPublicRedistribution: false,
    attributionString: "WeatherCorp Commercial Feed",
    expiresAtMs: 50 * dayMs,
  });

  // 40 days before expiry -> active, raw storage prohibited per ToS
  const activeEval = registry.evaluateSourceLicense("commercial-weather", 10 * dayMs);
  assert.equal(activeEval.state, "active");
  assert.equal(activeEval.permitRawStorage, false);
  assert.equal(activeEval.permitOnChainDerivedPublication, true);

  // 15 days before expiry -> expiring_soon warning
  const warningEval = registry.evaluateSourceLicense("commercial-weather", 35 * dayMs);
  assert.equal(warningEval.state, "expiring_soon");
  assert.equal(warningEval.daysUntilExpiry, 15);

  // Past expiry -> suspended and all permissions revoked
  const expiredEval = registry.evaluateSourceLicense("commercial-weather", 55 * dayMs);
  assert.equal(expiredEval.state, "suspended");
  assert.equal(expiredEval.permitOnChainDerivedPublication, false);
});
