import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ProviderAdapterConformanceRunner,
  AdapterCertificationAdmissionGate,
  type CandidateProviderAdapter,
  type ConformanceFixtureInput,
} from "./adapterConformanceKit.ts";

describe("Provider Adapter Conformance and Certification Test Kit (#214)", () => {
  it("certifies a compliant adapter and admits it at non-zero consensus weight while rejecting expired or uncertified adapters", async () => {
    const seenNonces = new Set<string>();
    const compliantAdapter: CandidateProviderAdapter = {
      adapterId: "pyth-hermes-v2",
      adapterVersion: "2.1.0",
      processFixture: async (input: ConformanceFixtureInput) => {
        if (seenNonces.has(input.nonce)) return null;
        const raw = Number(input.rawMantissa);
        if (!Number.isFinite(raw)) return null;
        if (input.observedAtMs > input.evaluationNowMs + 5_000) return null;
        if (input.evaluationNowMs - input.observedAtMs > 60_000) return null;

        seenNonces.add(input.nonce);
        return {
          canonicalValue: Number(
            (raw / Math.pow(10, input.decimals)).toFixed(8)
          ),
          observedAtMs: input.observedAtMs,
          nonce: input.nonce,
        };
      },
    };

    const runner = new ProviderAdapterConformanceRunner();
    const nowMs = 1_700_000_000_000;
    const report = await runner.runSuite(compliantAdapter, {
      nowMs,
      validityWindowMs: 60_000,
    });

    assert.equal(report.passedAllChecks, true);
    assert.equal(report.checks.length, 5);

    const gate = new AdapterCertificationAdmissionGate();
    // Before recording certification -> fail closed with 0 weight
    const uncertified = gate.evaluateConsensusAdmission({
      adapterId: "pyth-hermes-v2",
      adapterVersion: "2.1.0",
      requestedWeight: 100,
      nowMs,
    });
    assert.equal(uncertified.admitted, false);
    assert.equal(uncertified.assignedConsensusWeight, 0);
    assert.equal(uncertified.rejectionReason, "MISSING_CERTIFICATION");

    // Record certification -> admitted with weight 100
    gate.recordCertificationReport(report);
    const admitted = gate.evaluateConsensusAdmission({
      adapterId: "pyth-hermes-v2",
      adapterVersion: "2.1.0",
      requestedWeight: 100,
      nowMs: nowMs + 10_000,
    });
    assert.equal(admitted.admitted, true);
    assert.equal(admitted.assignedConsensusWeight, 100);

    // After expiry -> fail closed
    const expired = gate.evaluateConsensusAdmission({
      adapterId: "pyth-hermes-v2",
      adapterVersion: "2.1.0",
      requestedWeight: 100,
      nowMs: nowMs + 90_000,
    });
    assert.equal(expired.admitted, false);
    assert.equal(expired.assignedConsensusWeight, 0);
    assert.equal(expired.rejectionReason, "CERTIFICATION_EXPIRED");
  });

  it("detects non-compliant adapters that fail unit scaling, replay protection, or future-timestamp checks", async () => {
    const buggyAdapter: CandidateProviderAdapter = {
      adapterId: "buggy-provider",
      adapterVersion: "0.1.0",
      processFixture: async (input: ConformanceFixtureInput) => ({
        // Ignores decimals, accepts future timestamps and replayed nonces
        canonicalValue: Number(input.rawMantissa) || 0,
        observedAtMs: input.observedAtMs,
        nonce: input.nonce,
      }),
    };

    const runner = new ProviderAdapterConformanceRunner();
    const report = await runner.runSuite(buggyAdapter, {
      nowMs: 1_700_000_000_000,
    });
    assert.equal(report.passedAllChecks, false);

    const gate = new AdapterCertificationAdmissionGate();
    gate.recordCertificationReport(report);
    const decision = gate.evaluateConsensusAdmission({
      adapterId: "buggy-provider",
      adapterVersion: "0.1.0",
      requestedWeight: 50,
      nowMs: 1_700_000_001_000,
    });
    assert.equal(decision.admitted, false);
    assert.equal(decision.assignedConsensusWeight, 0);
    assert.equal(decision.rejectionReason, "FAILED_CONFORMANCE_CHECKS");
  });
});
