import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ProviderSandboxPlayground,
  signSandboxSubmission,
} from "./providerSandbox.ts";

describe("ProviderSandboxPlayground (Issue #253)", () => {
  it("evaluates corroborated and rejected sandbox readings with simulated trust tiers and never publishes on-chain", () => {
    const sandbox = new ProviderSandboxPlayground({ retentionTtlMs: 60_000 });
    const nowMs = 1_700_000_000_000;

    sandbox.registerSandboxProvider({
      providerId: "acme-weather",
      signingSecret: "acme-sandbox-secret-123",
      registeredAtMs: nowMs,
      maxRequestsPerMinute: 3,
    });

    sandbox.setReferenceFeedSnapshot({
      feedId: "rainfall-miami",
      referenceValues: [100, 102, 98],
      maxAllowedDeviationRatio: 0.05,
      maxStalenessMs: 30_000,
    });

    // 1. Valid corroborated submission close to reference median (100)
    const validPayload = {
      providerId: "acme-weather",
      feedId: "rainfall-miami",
      value: 100.5,
      observedAtMs: nowMs - 5_000,
      receivedAtMs: nowMs,
    };
    const validReport = sandbox.submitSandboxReading({
      ...validPayload,
      signature: signSandboxSubmission(validPayload, "acme-sandbox-secret-123"),
    });

    assert.equal(validReport.accepted, true);
    assert.equal(validReport.corroborated, true);
    assert.equal(validReport.simulatedTrustTier, "tier_1_trusted");
    assert.equal(validReport.onChainPublishEnabled, false);
    assert.equal(validReport.publishedOnChain, false);

    // 2. Outlier reading rejected and assigned tier_3_quarantined
    const outlierPayload = {
      providerId: "acme-weather",
      feedId: "rainfall-miami",
      value: 140,
      observedAtMs: nowMs - 2_000,
      receivedAtMs: nowMs + 100,
    };
    const outlierReport = sandbox.submitSandboxReading({
      ...outlierPayload,
      signature: signSandboxSubmission(
        outlierPayload,
        "acme-sandbox-secret-123"
      ),
    });

    assert.equal(outlierReport.accepted, false);
    assert.equal(outlierReport.rejectionReason, "OUTLIER_DEVIATION");
    assert.equal(outlierReport.simulatedTrustTier, "tier_3_quarantined");

    // 3. Invalid signature rejected
    const badSigReport = sandbox.submitSandboxReading({
      ...validPayload,
      receivedAtMs: nowMs + 200,
      signature: "invalid-signature",
    });
    assert.equal(badSigReport.accepted, false);
    assert.equal(badSigReport.rejectionReason, "INVALID_SIGNATURE");

    // 4. 4th request within 1 minute hits rate limit
    const rateLimitedReport = sandbox.submitSandboxReading({
      ...validPayload,
      receivedAtMs: nowMs + 300,
      signature: signSandboxSubmission(validPayload, "acme-sandbox-secret-123"),
    });
    assert.equal(rateLimitedReport.accepted, false);
    assert.equal(rateLimitedReport.rejectionReason, "RATE_LIMIT_EXCEEDED");
  });

  it("enforces strict namespace isolation from production queries and purges expired sandbox records", () => {
    const sandbox = new ProviderSandboxPlayground({ retentionTtlMs: 10_000 });
    const nowMs = 1_700_000_000_000;

    sandbox.registerSandboxProvider({
      providerId: "partner-x",
      signingSecret: "partner-x-secret-key",
      registeredAtMs: nowMs,
    });
    sandbox.recordProductionReading("rainfall-miami", 101);

    const sbxPayload = {
      providerId: "partner-x",
      feedId: "rainfall-miami",
      value: 101,
      observedAtMs: nowMs - 1_000,
      receivedAtMs: nowMs,
    };
    sandbox.submitSandboxReading({
      ...sbxPayload,
      signature: signSandboxSubmission(sbxPayload, "partner-x-secret-key"),
    });

    const prodRows = sandbox.queryProductionReadings("rainfall-miami");
    assert.equal(prodRows.length, 1);
    assert.equal(prodRows[0]?.namespace, "production");

    assert.equal(sandbox.querySandboxReports("partner-x").length, 1);
    const purgedCount = sandbox.purgeExpiredSandboxData(nowMs + 15_000);
    assert.equal(purgedCount, 1);
    assert.equal(sandbox.querySandboxReports("partner-x").length, 0);
  });
});
