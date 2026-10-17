export type ReconciliationDriftClass =
  | "MISSING_LOCAL_RECEIPT"
  | "MISSING_ON_CHAIN_VALUE"
  | "VALUE_MISMATCH"
  | "TIMESTAMP_MISMATCH"
  | "UNEXPECTED_ON_CHAIN_WRITER";

export interface LocalPublishedRecord {
  decisionId: string;
  feedId: string;
  roundId: string;
  value: number;
  observedAtMs: number;
  txHash: string | null;
}

export interface OnChainPublishedRecord {
  feedId: string;
  roundId: string;
  value: number;
  observedAtMs: number;
  txHash: string;
  submitter: string;
}

export interface DriftFinding {
  driftClass: ReconciliationDriftClass;
  feedId: string;
  roundId: string;
  autoRepaired: boolean;
  requiresHumanReview: boolean;
  detail: string;
}

export interface ReconciliationRunSummary {
  windowStartMs: number;
  windowEndMs: number;
  evaluatedCount: number;
  autoRepairedReceipts: number;
  humanReviewCount: number;
  countsByClass: Record<ReconciliationDriftClass, number>;
  findings: DriftFinding[];
}

export class BackendChainReconciler {
  private readonly lookbackWindowMs: number;
  private readonly finalityBufferMs: number;
  private readonly authorizedSubmitters: Set<string>;
  private readonly cumulativeCounts: Record<ReconciliationDriftClass, number> =
    {
      MISSING_LOCAL_RECEIPT: 0,
      MISSING_ON_CHAIN_VALUE: 0,
      VALUE_MISMATCH: 0,
      TIMESTAMP_MISMATCH: 0,
      UNEXPECTED_ON_CHAIN_WRITER: 0,
    };

  constructor(options: {
    lookbackWindowMs?: number;
    finalityBufferMs?: number;
    authorizedSubmitters: string[];
  }) {
    this.lookbackWindowMs = options.lookbackWindowMs ?? 3_600_000;
    this.finalityBufferMs = options.finalityBufferMs ?? 15_000;
    this.authorizedSubmitters = new Set(options.authorizedSubmitters);
  }

  public reconcile(params: {
    nowMs: number;
    localRecords: LocalPublishedRecord[];
    onChainRecords: OnChainPublishedRecord[];
  }): ReconciliationRunSummary {
    const windowStartMs = params.nowMs - this.lookbackWindowMs;
    const windowEndMs = params.nowMs - this.finalityBufferMs;

    const countsByClass: Record<ReconciliationDriftClass, number> = {
      MISSING_LOCAL_RECEIPT: 0,
      MISSING_ON_CHAIN_VALUE: 0,
      VALUE_MISMATCH: 0,
      TIMESTAMP_MISMATCH: 0,
      UNEXPECTED_ON_CHAIN_WRITER: 0,
    };
    const findings: DriftFinding[] = [];
    let autoRepairedReceipts = 0;

    // Filter to finalized lookback window
    const localInWindow = params.localRecords.filter(
      (r) => r.observedAtMs >= windowStartMs && r.observedAtMs <= windowEndMs
    );
    const chainInWindow = params.onChainRecords.filter(
      (r) => r.observedAtMs >= windowStartMs && r.observedAtMs <= windowEndMs
    );

    const localByKey = new Map<string, LocalPublishedRecord>();
    for (const loc of localInWindow) {
      localByKey.set(`${loc.feedId}:${loc.roundId}`, loc);
    }

    const chainByKey = new Map<string, OnChainPublishedRecord>();
    for (const ch of chainInWindow) {
      chainByKey.set(`${ch.feedId}:${ch.roundId}`, ch);
    }

    // 1. Check all local records against on-chain state
    for (const [key, loc] of localByKey.entries()) {
      const ch = chainByKey.get(key);
      if (!ch) {
        this.recordDrift(countsByClass, findings, {
          driftClass: "MISSING_ON_CHAIN_VALUE",
          feedId: loc.feedId,
          roundId: loc.roundId,
          autoRepaired: false,
          requiresHumanReview: true,
          detail: `Local decision '${loc.decisionId}' not found on-chain`,
        });
        continue;
      }

      if (!this.authorizedSubmitters.has(ch.submitter)) {
        this.recordDrift(countsByClass, findings, {
          driftClass: "UNEXPECTED_ON_CHAIN_WRITER",
          feedId: loc.feedId,
          roundId: loc.roundId,
          autoRepaired: false,
          requiresHumanReview: true,
          detail: `On-chain submitter '${ch.submitter}' is not in authorized relayer set`,
        });
      }

      if (Math.abs(loc.value - ch.value) > 1e-8) {
        // Never auto-rewrite value mismatches
        this.recordDrift(countsByClass, findings, {
          driftClass: "VALUE_MISMATCH",
          feedId: loc.feedId,
          roundId: loc.roundId,
          autoRepaired: false,
          requiresHumanReview: true,
          detail: `Local value (${loc.value}) differs from on-chain value (${ch.value})`,
        });
        continue;
      }

      if (loc.observedAtMs !== ch.observedAtMs) {
        this.recordDrift(countsByClass, findings, {
          driftClass: "TIMESTAMP_MISMATCH",
          feedId: loc.feedId,
          roundId: loc.roundId,
          autoRepaired: false,
          requiresHumanReview: true,
          detail: `Local observedAtMs (${loc.observedAtMs}) differs from on-chain (${ch.observedAtMs})`,
        });
        continue;
      }

      if (
        loc.txHash === null &&
        this.authorizedSubmitters.has(ch.submitter)
      ) {
        // Safe auto-repair: backfill missing receipt txHash when value/timestamp/writer match
        loc.txHash = ch.txHash;
        autoRepairedReceipts += 1;
        this.recordDrift(countsByClass, findings, {
          driftClass: "MISSING_LOCAL_RECEIPT",
          feedId: loc.feedId,
          roundId: loc.roundId,
          autoRepaired: true,
          requiresHumanReview: false,
          detail: `Backfilled missing local txHash '${ch.txHash}' from verified on-chain state`,
        });
      }
    }

    // 2. Check for unexpected extra on-chain writes with no local record
    for (const [key, ch] of chainByKey.entries()) {
      if (!localByKey.has(key)) {
        this.recordDrift(countsByClass, findings, {
          driftClass: "UNEXPECTED_ON_CHAIN_WRITER",
          feedId: ch.feedId,
          roundId: ch.roundId,
          autoRepaired: false,
          requiresHumanReview: true,
          detail: `Unmatched on-chain round '${ch.roundId}' written by '${ch.submitter}'`,
        });
      }
    }

    return {
      windowStartMs,
      windowEndMs,
      evaluatedCount: localInWindow.length + chainInWindow.length,
      autoRepairedReceipts,
      humanReviewCount: findings.filter((f) => f.requiresHumanReview).length,
      countsByClass,
      findings,
    };
  }

  private recordDrift(
    runCounts: Record<ReconciliationDriftClass, number>,
    findings: DriftFinding[],
    finding: DriftFinding
  ): void {
    runCounts[finding.driftClass] += 1;
    this.cumulativeCounts[finding.driftClass] += 1;
    findings.push(finding);
  }

  public getCumulativeDriftMetrics(): Record<ReconciliationDriftClass, number> {
    return { ...this.cumulativeCounts };
  }
}
