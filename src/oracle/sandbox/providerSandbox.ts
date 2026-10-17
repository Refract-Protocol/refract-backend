import { createHmac } from "node:crypto";

export type EnvironmentNamespace = "sandbox" | "production";

export type SimulatedTrustTier =
  | "tier_1_trusted"
  | "tier_2_corroborated"
  | "tier_3_quarantined"
  | "rejected";

export interface SandboxProviderRegistration {
  providerId: string;
  signingSecret: string;
  registeredAtMs: number;
  maxRequestsPerMinute?: number;
}

export interface SandboxReadingSubmission {
  providerId: string;
  feedId: string;
  value: number;
  observedAtMs: number;
  receivedAtMs: number;
  signature?: string;
}

export interface ReferenceFeedSnapshot {
  feedId: string;
  referenceValues: number[];
  maxAllowedDeviationRatio: number;
  maxStalenessMs: number;
}

export interface SandboxEvaluationReport {
  submissionId: string;
  namespace: "sandbox";
  providerId: string;
  feedId: string;
  accepted: boolean;
  rejectionReason?:
    | "UNREGISTERED_PROVIDER"
    | "INVALID_SIGNATURE"
    | "RATE_LIMIT_EXCEEDED"
    | "STALE_READING"
    | "OUTLIER_DEVIATION";
  signatureVerified: boolean;
  corroborated: boolean;
  referenceMedian?: number;
  deviationRatio?: number;
  simulatedTrustTier: SimulatedTrustTier;
  onChainPublishEnabled: false;
  publishedOnChain: false;
  expiresAtMs: number;
}

export function signSandboxSubmission(
  submission: Omit<SandboxReadingSubmission, "signature">,
  signingSecret: string
): string {
  const canonical = `${submission.providerId}:${submission.feedId}:${submission.value}:${submission.observedAtMs}`;
  return createHmac("sha256", signingSecret).update(canonical).digest("hex");
}

function computeMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

export class ProviderSandboxPlayground {
  private readonly providers = new Map<string, SandboxProviderRegistration>();
  private readonly referenceFeeds = new Map<string, ReferenceFeedSnapshot>();
  private readonly sandboxRecords: SandboxEvaluationReport[] = [];
  private readonly productionRecords: Array<{
    submissionId: string;
    namespace: "production";
    feedId: string;
    value: number;
  }> = [];
  private readonly rateBuckets = new Map<string, number[]>();
  private readonly retentionTtlMs: number;
  private seq = 0;

  constructor(options?: { retentionTtlMs?: number }) {
    this.retentionTtlMs = options?.retentionTtlMs ?? 24 * 60 * 60 * 1_000;
  }

  public registerSandboxProvider(reg: SandboxProviderRegistration): void {
    if (!reg.providerId || !reg.signingSecret || reg.signingSecret.length < 8) {
      throw new Error("Invalid sandbox provider registration");
    }
    this.providers.set(reg.providerId, {
      ...reg,
      maxRequestsPerMinute: reg.maxRequestsPerMinute ?? 30,
    });
  }

  public setReferenceFeedSnapshot(snapshot: ReferenceFeedSnapshot): void {
    if (snapshot.referenceValues.length === 0) {
      throw new Error(`Reference feed ${snapshot.feedId} requires at least one value`);
    }
    this.referenceFeeds.set(snapshot.feedId, snapshot);
  }

  public recordProductionReading(feedId: string, value: number): void {
    this.seq += 1;
    this.productionRecords.push({
      submissionId: `prod-${this.seq}`,
      namespace: "production",
      feedId,
      value,
    });
  }

  public submitSandboxReading(
    submission: SandboxReadingSubmission
  ): SandboxEvaluationReport {
    this.seq += 1;
    const submissionId = `sbx-${this.seq}`;
    const expiresAtMs = submission.receivedAtMs + this.retentionTtlMs;

    const provider = this.providers.get(submission.providerId);
    if (!provider) {
      const report: SandboxEvaluationReport = {
        submissionId,
        namespace: "sandbox",
        providerId: submission.providerId,
        feedId: submission.feedId,
        accepted: false,
        rejectionReason: "UNREGISTERED_PROVIDER",
        signatureVerified: false,
        corroborated: false,
        simulatedTrustTier: "rejected",
        onChainPublishEnabled: false,
        publishedOnChain: false,
        expiresAtMs,
      };
      this.sandboxRecords.push(report);
      return report;
    }

    if (
      !this.consumeRateLimit(
        provider.providerId,
        provider.maxRequestsPerMinute ?? 30,
        submission.receivedAtMs
      )
    ) {
      const report: SandboxEvaluationReport = {
        submissionId,
        namespace: "sandbox",
        providerId: submission.providerId,
        feedId: submission.feedId,
        accepted: false,
        rejectionReason: "RATE_LIMIT_EXCEEDED",
        signatureVerified: false,
        corroborated: false,
        simulatedTrustTier: "rejected",
        onChainPublishEnabled: false,
        publishedOnChain: false,
        expiresAtMs,
      };
      this.sandboxRecords.push(report);
      return report;
    }

    const expectedSig = signSandboxSubmission(submission, provider.signingSecret);
    const signatureVerified =
      typeof submission.signature === "string" &&
      submission.signature === expectedSig;

    if (!signatureVerified) {
      const report: SandboxEvaluationReport = {
        submissionId,
        namespace: "sandbox",
        providerId: submission.providerId,
        feedId: submission.feedId,
        accepted: false,
        rejectionReason: "INVALID_SIGNATURE",
        signatureVerified: false,
        corroborated: false,
        simulatedTrustTier: "rejected",
        onChainPublishEnabled: false,
        publishedOnChain: false,
        expiresAtMs,
      };
      this.sandboxRecords.push(report);
      return report;
    }

    const feed = this.referenceFeeds.get(submission.feedId);
    const maxStalenessMs = feed?.maxStalenessMs ?? 60_000;
    const ageMs = submission.receivedAtMs - submission.observedAtMs;

    if (ageMs > maxStalenessMs || ageMs < -5_000) {
      const report: SandboxEvaluationReport = {
        submissionId,
        namespace: "sandbox",
        providerId: submission.providerId,
        feedId: submission.feedId,
        accepted: false,
        rejectionReason: "STALE_READING",
        signatureVerified: true,
        corroborated: false,
        simulatedTrustTier: "rejected",
        onChainPublishEnabled: false,
        publishedOnChain: false,
        expiresAtMs,
      };
      this.sandboxRecords.push(report);
      return report;
    }

    const referenceMedian = feed
      ? computeMedian(feed.referenceValues)
      : submission.value;
    const denominator = Math.max(Math.abs(referenceMedian), 1e-9);
    const deviationRatio =
      Math.abs(submission.value - referenceMedian) / denominator;
    const maxDeviation = feed?.maxAllowedDeviationRatio ?? 0.1;

    if (deviationRatio > maxDeviation) {
      const report: SandboxEvaluationReport = {
        submissionId,
        namespace: "sandbox",
        providerId: submission.providerId,
        feedId: submission.feedId,
        accepted: false,
        rejectionReason: "OUTLIER_DEVIATION",
        signatureVerified: true,
        corroborated: false,
        referenceMedian,
        deviationRatio,
        simulatedTrustTier: "tier_3_quarantined",
        onChainPublishEnabled: false,
        publishedOnChain: false,
        expiresAtMs,
      };
      this.sandboxRecords.push(report);
      return report;
    }

    const simulatedTrustTier: SimulatedTrustTier =
      deviationRatio <= maxDeviation * 0.25
        ? "tier_1_trusted"
        : "tier_2_corroborated";

    const report: SandboxEvaluationReport = {
      submissionId,
      namespace: "sandbox",
      providerId: submission.providerId,
      feedId: submission.feedId,
      accepted: true,
      signatureVerified: true,
      corroborated: true,
      referenceMedian,
      deviationRatio,
      simulatedTrustTier,
      onChainPublishEnabled: false,
      publishedOnChain: false,
      expiresAtMs,
    };
    this.sandboxRecords.push(report);
    return report;
  }

  public queryProductionReadings(feedId: string): Array<{
    submissionId: string;
    namespace: "production";
    feedId: string;
    value: number;
  }> {
    return this.productionRecords.filter(
      (r) => r.namespace === "production" && r.feedId === feedId
    );
  }

  public querySandboxReports(providerId: string): SandboxEvaluationReport[] {
    return this.sandboxRecords.filter(
      (r) => r.namespace === "sandbox" && r.providerId === providerId
    );
  }

  public purgeExpiredSandboxData(nowMs: number): number {
    const before = this.sandboxRecords.length;
    const remaining = this.sandboxRecords.filter((r) => r.expiresAtMs > nowMs);
    this.sandboxRecords.length = 0;
    this.sandboxRecords.push(...remaining);
    return before - remaining.length;
  }

  private consumeRateLimit(
    providerId: string,
    maxPerMinute: number,
    nowMs: number
  ): boolean {
    const windowStart = nowMs - 60_000;
    const existing = (this.rateBuckets.get(providerId) ?? []).filter(
      (ts) => ts > windowStart
    );
    if (existing.length >= maxPerMinute) {
      this.rateBuckets.set(providerId, existing);
      return false;
    }
    existing.push(nowMs);
    this.rateBuckets.set(providerId, existing);
    return true;
  }
}
