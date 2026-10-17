import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderOffboardingManager } from "./providerOffboardingManager.ts";

test("ProviderOffboardingManager retires source, supports dry-run purge, preserves content hashes, and allows re-onboarding", () => {
  const manager = new ProviderOffboardingManager();
  manager.registerProvider("legacy-weather", 30);

  const dayMs = 24 * 60 * 60 * 1_000;
  manager.addReading({
    readingId: "r-old",
    sourceId: "legacy-weather",
    observedAtMs: 1_000,
    normalizedValue: 42.5,
    contentHash: "sha256:abc123",
    rawPayloadBody: '{"raw":"licensed-data"}',
  });

  const retired = manager.offboardProvider("legacy-weather", 10 * dayMs);
  assert.equal(retired.status, "retired");
  assert.equal(retired.credentialsRevoked, true);

  // Dry-run identifies r-old past 30-day window without mutating
  const dryRun = manager.purgeExpiredRawPayloads({
    sourceId: "legacy-weather",
    nowMs: 35 * dayMs,
    dryRun: true,
  });
  assert.deepEqual(dryRun.eligibleReadingIds, ["r-old"]);
  assert.equal(dryRun.purgedCount, 0);
  assert.equal(manager.getReading("r-old")?.rawPayloadBody, '{"raw":"licensed-data"}');

  // Execute purge: raw body removed, content hash and normalized value preserved
  const executed = manager.purgeExpiredRawPayloads({
    sourceId: "legacy-weather",
    nowMs: 35 * dayMs,
    dryRun: false,
  });
  assert.equal(executed.purgedCount, 1);
  const afterPurge = manager.getReading("r-old")!;
  assert.equal(afterPurge.rawPayloadBody, null);
  assert.equal(afterPurge.contentHash, "sha256:abc123");
  assert.equal(afterPurge.normalizedValue, 42.5);
  assert.equal(afterPurge.purgeReason, "license_retention_expired");

  // Re-onboarding restores active status cleanly
  const reactivated = manager.reOnboardProvider("legacy-weather");
  assert.equal(reactivated.status, "active");
  assert.equal(reactivated.credentialsRevoked, false);
});
