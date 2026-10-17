import { createHash } from "node:crypto";

export type OperatorRole = "viewer" | "previewer" | "admin";

export interface ActivePolicySnapshot {
  policyId: string;
  feedId: string;
  triggerDirection: "below" | "above";
  threshold: number;
  coverageAmount: number;
  existingCorroboratedTriggered: boolean;
}

export interface PolicyImpactItem {
  policyId: string;
  coverageAmount: number;
  currentlyTriggered: boolean;
  wouldTriggerUnderOverride: boolean;
  inconsistentWithExistingEvidence: boolean;
}

export interface OverrideImpactPreview {
  previewId: string;
  feedId: string;
  proposedValue: number | null;
  suppressed: boolean;
  actor: string;
  rationale: string;
  createdAtMs: number;
  expiresAtMs: number;
  policySnapshotHash: string;
  policyImpacts: PolicyImpactItem[];
  newlyTriggeredPolicyIds: string[];
  totalPayoutExposure: number;
}

export interface OverrideEvidenceRecord {
  recordType: "OVERRIDE_PREVIEW" | "OVERRIDE_APPLIED";
  previewId: string;
  feedId: string;
  actor: string;
  rationale: string;
  timestampMs: number;
  totalPayoutExposure: number;
}

/**
 * Pure, side-effect-free trigger evaluation shared by both dry-run preview and actual override application.
 */
export function evaluatePolicyTrigger(
  policy: Pick<ActivePolicySnapshot, "triggerDirection" | "threshold">,
  feedValue: number | null,
  suppressed: boolean
): boolean {
  if (suppressed || feedValue === null) {
    return false;
  }
  return policy.triggerDirection === "below"
    ? feedValue < policy.threshold
    : feedValue > policy.threshold;
}

export class OverrideImpactPreviewService {
  private readonly previewTtlMs: number;
  private readonly exposureCeiling: number;
  private readonly feedValues = new Map<
    string,
    { value: number | null; suppressed: boolean }
  >();
  private policies: ActivePolicySnapshot[] = [];
  private readonly previews = new Map<string, OverrideImpactPreview>();
  private readonly evidenceLedger: OverrideEvidenceRecord[] = [];
  private previewSeq = 0;

  constructor(options?: { previewTtlMs?: number; exposureCeiling?: number }) {
    this.previewTtlMs = options?.previewTtlMs ?? 60_000;
    this.exposureCeiling = options?.exposureCeiling ?? 100_000;
  }

  public setFeedState(
    feedId: string,
    value: number | null,
    suppressed: boolean = false
  ): void {
    this.feedValues.set(feedId, { value, suppressed });
  }

  public getFeedState(
    feedId: string
  ): { value: number | null; suppressed: boolean } | undefined {
    return this.feedValues.get(feedId);
  }

  public setActivePolicies(policies: ActivePolicySnapshot[]): void {
    this.policies = policies.map((p) => ({ ...p }));
  }

  public getEvidenceLedger(): OverrideEvidenceRecord[] {
    return [...this.evidenceLedger];
  }

  private computePolicySnapshotHash(feedId: string): string {
    const relevant = this.policies
      .filter((p) => p.feedId === feedId)
      .sort((a, b) => a.policyId.localeCompare(b.policyId));
    return createHash("sha256").update(JSON.stringify(relevant)).digest("hex");
  }

  public previewOverride(params: {
    feedId: string;
    proposedValue: number | null;
    suppressed?: boolean;
    actor: string;
    role: OperatorRole;
    rationale: string;
    nowMs?: number;
  }): OverrideImpactPreview {
    if (params.role !== "previewer" && params.role !== "admin") {
      throw new Error("UNAUTHORIZED_PREVIEW_ROLE");
    }

    const nowMs = params.nowMs ?? Date.now();
    const suppressed = Boolean(params.suppressed);
    const currentFeed = this.feedValues.get(params.feedId) ?? {
      value: null,
      suppressed: false,
    };
    const feedPolicies = this.policies.filter(
      (p) => p.feedId === params.feedId
    );

    const policyImpacts: PolicyImpactItem[] = [];
    const newlyTriggeredPolicyIds: string[] = [];
    let totalPayoutExposure = 0;

    for (const p of feedPolicies) {
      const currentlyTriggered = evaluatePolicyTrigger(
        p,
        currentFeed.value,
        currentFeed.suppressed
      );
      const wouldTriggerUnderOverride = evaluatePolicyTrigger(
        p,
        params.proposedValue,
        suppressed
      );
      if (wouldTriggerUnderOverride) {
        totalPayoutExposure += p.coverageAmount;
        if (!currentlyTriggered) {
          newlyTriggeredPolicyIds.push(p.policyId);
        }
      }
      policyImpacts.push({
        policyId: p.policyId,
        coverageAmount: p.coverageAmount,
        currentlyTriggered,
        wouldTriggerUnderOverride,
        inconsistentWithExistingEvidence:
          wouldTriggerUnderOverride !== p.existingCorroboratedTriggered,
      });
    }

    this.previewSeq += 1;
    const previewId = `prev-${this.previewSeq}`;
    const preview: OverrideImpactPreview = {
      previewId,
      feedId: params.feedId,
      proposedValue: params.proposedValue,
      suppressed,
      actor: params.actor,
      rationale: params.rationale,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.previewTtlMs,
      policySnapshotHash: this.computePolicySnapshotHash(params.feedId),
      policyImpacts,
      newlyTriggeredPolicyIds,
      totalPayoutExposure,
    };

    this.previews.set(previewId, preview);
    this.evidenceLedger.push({
      recordType: "OVERRIDE_PREVIEW",
      previewId,
      feedId: params.feedId,
      actor: params.actor,
      rationale: params.rationale,
      timestampMs: nowMs,
      totalPayoutExposure,
    });

    return preview;
  }

  public applyOverride(params: {
    previewId: string;
    actor: string;
    role: OperatorRole;
    ceilingApprovalToken?: string;
    nowMs?: number;
  }): { triggeredPolicyIds: string[]; totalPayoutExposure: number } {
    if (params.role !== "admin") {
      throw new Error("UNAUTHORIZED_APPLY_ROLE");
    }

    const nowMs = params.nowMs ?? Date.now();
    const preview = this.previews.get(params.previewId);
    if (!preview) {
      throw new Error("UNKNOWN_PREVIEW_TOKEN");
    }

    if (nowMs > preview.expiresAtMs) {
      throw new Error("EXPIRED_PREVIEW_TOKEN");
    }

    const currentSnapshotHash = this.computePolicySnapshotHash(preview.feedId);
    if (currentSnapshotHash !== preview.policySnapshotHash) {
      throw new Error("POLICY_SNAPSHOT_MUTATED_SINCE_PREVIEW");
    }

    if (
      preview.totalPayoutExposure > this.exposureCeiling &&
      !params.ceilingApprovalToken
    ) {
      throw new Error("EXPOSURE_CEILING_EXCEEDED");
    }

    // Apply the override state
    this.feedValues.set(preview.feedId, {
      value: preview.proposedValue,
      suppressed: preview.suppressed,
    });

    const feedPolicies = this.policies.filter(
      (p) => p.feedId === preview.feedId
    );
    const triggeredPolicyIds = feedPolicies
      .filter((p) =>
        evaluatePolicyTrigger(p, preview.proposedValue, preview.suppressed)
      )
      .map((p) => p.policyId);

    this.evidenceLedger.push({
      recordType: "OVERRIDE_APPLIED",
      previewId: preview.previewId,
      feedId: preview.feedId,
      actor: params.actor,
      rationale: preview.rationale,
      timestampMs: nowMs,
      totalPayoutExposure: preview.totalPayoutExposure,
    });

    return {
      triggeredPolicyIds,
      totalPayoutExposure: preview.totalPayoutExposure,
    };
  }
}
