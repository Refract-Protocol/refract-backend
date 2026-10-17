export interface ConformanceFixtureInput {
  scenario:
    | "valid_scaled_reading"
    | "future_dated_timestamp"
    | "stale_timestamp"
    | "duplicate_nonce_replay"
    | "malformed_nan_payload";
  nonce: string;
  rawMantissa: string;
  decimals: number;
  observedAtMs: number;
  evaluationNowMs: number;
}

export interface NormalizedCandidateOutput {
  canonicalValue: number;
  observedAtMs: number;
  nonce: string;
}

export interface CandidateProviderAdapter {
  readonly adapterId: string;
  readonly adapterVersion: string;
  processFixture(
    input: ConformanceFixtureInput
  ): Promise<NormalizedCandidateOutput | null>;
}

export interface ConformanceCheckOutcome {
  checkId:
    | "schema_and_unit_normalization"
    | "future_timestamp_rejection"
    | "stale_timestamp_rejection"
    | "replay_nonce_rejection"
    | "malformed_payload_resilience";
  passed: boolean;
  detail: string;
}

export interface AdapterCertificationReport {
  specVersion: string;
  adapterId: string;
  adapterVersion: string;
  passedAllChecks: boolean;
  checks: ConformanceCheckOutcome[];
  certifiedAtMs: number;
  expiresAtMs: number;
}

export class ProviderAdapterConformanceRunner {
  public static readonly CURRENT_SPEC_VERSION = "refract-adapter-spec-v1";

  public async runSuite(
    adapter: CandidateProviderAdapter,
    options: { nowMs?: number; validityWindowMs?: number } = {}
  ): Promise<AdapterCertificationReport> {
    const nowMs = options.nowMs ?? Date.now();
    const validityWindowMs = options.validityWindowMs ?? 7 * 86_400_000;
    const checks: ConformanceCheckOutcome[] = [];

    // 1. Schema and unit normalization (100050000 with 8 decimals -> 1.0005)
    const validOut = await adapter.processFixture({
      scenario: "valid_scaled_reading",
      nonce: "nonce-valid-1",
      rawMantissa: "100050000",
      decimals: 8,
      observedAtMs: nowMs - 2_000,
      evaluationNowMs: nowMs,
    });
    const unitPassed =
      validOut !== null &&
      Math.abs(validOut.canonicalValue - 1.0005) < 1e-8 &&
      validOut.observedAtMs === nowMs - 2_000;
    checks.push({
      checkId: "schema_and_unit_normalization",
      passed: unitPassed,
      detail: unitPassed
        ? "Normalized 8-decimal mantissa to canonical 1.0005"
        : `Expected 1.0005, got ${validOut ? validOut.canonicalValue : "null"}`,
    });

    // 2. Replay nonce rejection (re-submitting nonce-valid-1 must be rejected)
    const replayOut = await adapter.processFixture({
      scenario: "duplicate_nonce_replay",
      nonce: "nonce-valid-1",
      rawMantissa: "100050000",
      decimals: 8,
      observedAtMs: nowMs - 1_000,
      evaluationNowMs: nowMs,
    });
    checks.push({
      checkId: "replay_nonce_rejection",
      passed: replayOut === null,
      detail:
        replayOut === null
          ? "Rejected duplicate nonce replay"
          : "Adapter accepted replayed nonce",
    });

    // 3. Future-dated timestamp rejection (+120s in the future)
    const futureOut = await adapter.processFixture({
      scenario: "future_dated_timestamp",
      nonce: "nonce-future-1",
      rawMantissa: "100000000",
      decimals: 8,
      observedAtMs: nowMs + 120_000,
      evaluationNowMs: nowMs,
    });
    checks.push({
      checkId: "future_timestamp_rejection",
      passed: futureOut === null,
      detail:
        futureOut === null
          ? "Rejected future-dated timestamp"
          : "Adapter accepted future-dated reading",
    });

    // 4. Stale timestamp rejection (-600s old)
    const staleOut = await adapter.processFixture({
      scenario: "stale_timestamp",
      nonce: "nonce-stale-1",
      rawMantissa: "100000000",
      decimals: 8,
      observedAtMs: nowMs - 600_000,
      evaluationNowMs: nowMs,
    });
    checks.push({
      checkId: "stale_timestamp_rejection",
      passed: staleOut === null,
      detail:
        staleOut === null
          ? "Rejected stale reading"
          : "Adapter accepted stale reading",
    });

    // 5. Malformed payload resilience (non-numeric mantissa must return null, never 0 or throw)
    let malformedPassed = false;
    try {
      const malformedOut = await adapter.processFixture({
        scenario: "malformed_nan_payload",
        nonce: "nonce-malformed-1",
        rawMantissa: "NOT_A_NUMBER",
        decimals: 8,
        observedAtMs: nowMs - 1_000,
        evaluationNowMs: nowMs,
      });
      malformedPassed = malformedOut === null;
    } catch {
      malformedPassed = false;
    }
    checks.push({
      checkId: "malformed_payload_resilience",
      passed: malformedPassed,
      detail: malformedPassed
        ? "Returned null cleanly on malformed mantissa"
        : "Failed to reject malformed payload cleanly",
    });

    const passedAllChecks = checks.every((c) => c.passed);
    return {
      specVersion: ProviderAdapterConformanceRunner.CURRENT_SPEC_VERSION,
      adapterId: adapter.adapterId,
      adapterVersion: adapter.adapterVersion,
      passedAllChecks,
      checks,
      certifiedAtMs: nowMs,
      expiresAtMs: nowMs + validityWindowMs,
    };
  }
}

export class AdapterCertificationAdmissionGate {
  private readonly requiredSpecVersion: string;
  private readonly reportsByAdapterId = new Map<
    string,
    AdapterCertificationReport
  >();

  constructor(
    requiredSpecVersion: string = ProviderAdapterConformanceRunner.CURRENT_SPEC_VERSION
  ) {
    this.requiredSpecVersion = requiredSpecVersion;
  }

  public recordCertificationReport(report: AdapterCertificationReport): void {
    this.reportsByAdapterId.set(report.adapterId, report);
  }

  public evaluateConsensusAdmission(params: {
    adapterId: string;
    adapterVersion: string;
    requestedWeight: number;
    nowMs?: number;
  }): {
    admitted: boolean;
    assignedConsensusWeight: number;
    rejectionReason:
      | null
      | "MISSING_CERTIFICATION"
      | "FAILED_CONFORMANCE_CHECKS"
      | "SPEC_VERSION_MISMATCH"
      | "ADAPTER_VERSION_MISMATCH"
      | "CERTIFICATION_EXPIRED";
  } {
    const nowMs = params.nowMs ?? Date.now();
    const report = this.reportsByAdapterId.get(params.adapterId);

    if (!report) {
      return {
        admitted: false,
        assignedConsensusWeight: 0,
        rejectionReason: "MISSING_CERTIFICATION",
      };
    }
    if (!report.passedAllChecks) {
      return {
        admitted: false,
        assignedConsensusWeight: 0,
        rejectionReason: "FAILED_CONFORMANCE_CHECKS",
      };
    }
    if (report.specVersion !== this.requiredSpecVersion) {
      return {
        admitted: false,
        assignedConsensusWeight: 0,
        rejectionReason: "SPEC_VERSION_MISMATCH",
      };
    }
    if (report.adapterVersion !== params.adapterVersion) {
      return {
        admitted: false,
        assignedConsensusWeight: 0,
        rejectionReason: "ADAPTER_VERSION_MISMATCH",
      };
    }
    if (nowMs >= report.expiresAtMs) {
      return {
        admitted: false,
        assignedConsensusWeight: 0,
        rejectionReason: "CERTIFICATION_EXPIRED",
      };
    }

    return {
      admitted: true,
      assignedConsensusWeight: Math.max(0, params.requestedWeight),
      rejectionReason: null,
    };
  }
}
