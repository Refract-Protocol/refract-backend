/**
 * Versioned Provider Methodology Registry for Source Independence and Evidence (Issue #294)
 *
 * Captures immutable, versioned methodology metadata per oracle source (derivation,
 * sampling universe, revision policy, latency profile, and known failure modes),
 * gates source activation on approved methodology sign-off, caps independence weight
 * for opaque sources, and resolves exact historical methodology versions for decisions.
 */

export type RevisionPolicy =
  | "immutable_final"
  | "late_correction_allowed"
  | "retroactive_restatement";

export interface MethodologyRecordInput {
  sourceId: string;
  derivationDescription: string;
  samplingUniverse: string[];
  revisionPolicy: RevisionPolicy;
  expectedLatencyMs: number;
  knownFailureModes: string[];
  /** False if the provider's methodology is proprietary/unpublishable (caps independence weight) */
  publishableMethodology: boolean;
  approvedBy?: string;
  explicitSignOff: boolean;
  createdAtMs: number;
  reAttestationIntervalMs?: number;
}

export interface ProviderMethodologyRecord extends MethodologyRecordInput {
  version: number;
  reAttestationDueAtMs: number;
}

export interface SourceActivationState {
  sourceId: string;
  active: boolean;
  pinnedMethodologyVersion: number;
  effectiveIndependenceWeightBps: number;
  activatedAtMs: number;
}

export interface MethodologyDriftCheckResult {
  sourceId: string;
  version: number;
  reAttestationExpired: boolean;
  latencyDriftDetected: boolean;
  unauthorizedRevisionDetected: boolean;
  flags: string[];
}

export const DEFAULT_REATTESTATION_INTERVAL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
export const MAX_OPAQUE_INDEPENDENCE_WEIGHT_BPS = 5_000; // 0.5x max weight for unpublishable methodology

export class ProviderMethodologyRegistry {
  private readonly versionsBySource = new Map<string, Map<number, ProviderMethodologyRecord>>();
  private readonly latestVersionBySource = new Map<string, number>();
  private readonly activeSources = new Map<string, SourceActivationState>();

  /**
   * Registers a new immutable methodology version for `sourceId`.
   * Edits always create a new version (`version = prev + 1`) so historical decisions
   * continue to resolve to the exact methodology version in force at decision time.
   */
  registerMethodology(input: MethodologyRecordInput): ProviderMethodologyRecord {
    if (!input.sourceId || input.sourceId.trim() === "") {
      throw new Error("sourceId must be non-empty");
    }
    if (!input.derivationDescription || input.derivationDescription.trim() === "") {
      throw new Error(`Source "${input.sourceId}": derivationDescription is required`);
    }
    if (!Array.isArray(input.samplingUniverse) || input.samplingUniverse.length === 0) {
      throw new Error(`Source "${input.sourceId}": samplingUniverse must be non-empty`);
    }
    if (input.expectedLatencyMs <= 0) {
      throw new Error(`Source "${input.sourceId}": expectedLatencyMs must be positive`);
    }
    if (!Array.isArray(input.knownFailureModes) || input.knownFailureModes.length === 0) {
      throw new Error(`Source "${input.sourceId}": knownFailureModes must be non-empty`);
    }

    const sourceVersions =
      this.versionsBySource.get(input.sourceId) ??
      new Map<number, ProviderMethodologyRecord>();
    const nextVersion = (this.latestVersionBySource.get(input.sourceId) ?? 0) + 1;
    const interval = input.reAttestationIntervalMs ?? DEFAULT_REATTESTATION_INTERVAL_MS;

    const record: ProviderMethodologyRecord = {
      ...input,
      samplingUniverse: [...input.samplingUniverse],
      knownFailureModes: [...input.knownFailureModes],
      version: nextVersion,
      reAttestationDueAtMs: input.createdAtMs + interval,
    };

    sourceVersions.set(nextVersion, record);
    this.versionsBySource.set(input.sourceId, sourceVersions);
    this.latestVersionBySource.set(input.sourceId, nextVersion);

    return { ...record };
  }

  /**
   * Onboarding activation gate: a source cannot be activated without an approved
   * methodology record (`explicitSignOff === true` and non-empty `approvedBy`).
   * Sources with `publishableMethodology === false` are barred from higher
   * independence weights (clamped to `MAX_OPAQUE_INDEPENDENCE_WEIGHT_BPS`).
   */
  activateSource(params: {
    sourceId: string;
    requestedIndependenceWeightBps: number;
    methodologyVersion?: number;
    nowMs: number;
  }): SourceActivationState {
    const version =
      params.methodologyVersion ?? this.latestVersionBySource.get(params.sourceId);
    if (version === undefined) {
      throw new Error(
        `Cannot activate source "${params.sourceId}": no methodology record registered`
      );
    }

    const record = this.versionsBySource.get(params.sourceId)?.get(version);
    if (!record) {
      throw new Error(
        `Cannot activate source "${params.sourceId}": methodology version ${version} not found`
      );
    }

    if (!record.explicitSignOff || !record.approvedBy || record.approvedBy.trim() === "") {
      throw new Error(
        `Cannot activate source "${params.sourceId}": methodology v${version} lacks explicit approval sign-off`
      );
    }

    const effectiveIndependenceWeightBps = record.publishableMethodology
      ? params.requestedIndependenceWeightBps
      : Math.min(params.requestedIndependenceWeightBps, MAX_OPAQUE_INDEPENDENCE_WEIGHT_BPS);

    const state: SourceActivationState = {
      sourceId: params.sourceId,
      active: true,
      pinnedMethodologyVersion: version,
      effectiveIndependenceWeightBps,
      activatedAtMs: params.nowMs,
    };
    this.activeSources.set(params.sourceId, state);
    return { ...state };
  }

  /**
   * Resolves a specific historical methodology version for point-in-time reconstruction.
   */
  getMethodologyVersion(sourceId: string, version: number): ProviderMethodologyRecord {
    const rec = this.versionsBySource.get(sourceId)?.get(version);
    if (!rec) {
      throw new Error(`Methodology record not found for ${sourceId}@v${version}`);
    }
    return {
      ...rec,
      samplingUniverse: [...rec.samplingUniverse],
      knownFailureModes: [...rec.knownFailureModes],
    };
  }

  /**
   * Captures the active methodology version references for a set of contributing sources
   * to embed in a consensus decision / evidence record.
   */
  captureDecisionMethodologyReferences(
    contributingSourceIds: readonly string[]
  ): Record<string, number> {
    const refs: Record<string, number> = {};
    for (const sourceId of contributingSourceIds) {
      const active = this.activeSources.get(sourceId);
      if (!active || !active.active) {
        throw new Error(`Source "${sourceId}" is not active or lacks approved methodology`);
      }
      refs[sourceId] = active.pinnedMethodologyVersion;
    }
    return refs;
  }

  /**
   * Evaluates whether a source's observed runtime behavior diverges from its declared
   * methodology or whether its periodic re-attestation has expired.
   */
  evaluateBehavioralDrift(params: {
    sourceId: string;
    observedP95LatencyMs: number;
    observedLateCorrection: boolean;
    nowMs: number;
  }): MethodologyDriftCheckResult {
    const active = this.activeSources.get(params.sourceId);
    if (!active) {
      throw new Error(`Source "${params.sourceId}" is not active`);
    }
    const record = this.getMethodologyVersion(
      params.sourceId,
      active.pinnedMethodologyVersion
    );

    const flags: string[] = [];
    const reAttestationExpired = params.nowMs > record.reAttestationDueAtMs;
    if (reAttestationExpired) {
      flags.push("reattestation_overdue");
    }

    const latencyDriftDetected =
      params.observedP95LatencyMs > record.expectedLatencyMs * 2;
    if (latencyDriftDetected) {
      flags.push("observed_latency_exceeds_2x_methodology");
    }

    const unauthorizedRevisionDetected =
      params.observedLateCorrection && record.revisionPolicy === "immutable_final";
    if (unauthorizedRevisionDetected) {
      flags.push("unexpected_revision_under_immutable_final_policy");
    }

    return {
      sourceId: params.sourceId,
      version: record.version,
      reAttestationExpired,
      latencyDriftDetected,
      unauthorizedRevisionDetected,
      flags,
    };
  }

  /**
   * Renders public trust/provenance methodology metadata for a set of sources.
   */
  renderPublicProvenanceSurface(sourceIds: readonly string[]) {
    return sourceIds.map((sourceId) => {
      const active = this.activeSources.get(sourceId);
      if (!active) {
        return { sourceId, active: false };
      }
      const rec = this.getMethodologyVersion(sourceId, active.pinnedMethodologyVersion);
      return {
        sourceId,
        active: true,
        methodologyVersion: rec.version,
        derivationDescription: rec.derivationDescription,
        samplingUniverse: rec.samplingUniverse,
        revisionPolicy: rec.revisionPolicy,
        expectedLatencyMs: rec.expectedLatencyMs,
        publishableMethodology: rec.publishableMethodology,
        effectiveIndependenceWeightBps: active.effectiveIndependenceWeightBps,
      };
    });
  }
}
