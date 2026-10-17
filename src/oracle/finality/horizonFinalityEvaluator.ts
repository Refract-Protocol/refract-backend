export type ReadingFinalityStatus =
  | "provisional"
  | "final"
  | "invalidated_by_reorg";

export interface HorizonDerivedReading {
  readingId: string;
  feedId: string;
  value: number;
  ledgerSeq: number;
  ledgerHash: string;
  observedAtMs: number;
  finalityStatus: ReadingFinalityStatus;
  invalidatedReason?: string;
}

export interface FinalityTrackedDecision {
  decisionId: string;
  feedId: string;
  agreedValue: number;
  contributingReadingIds: string[];
  status: "valid" | "superseded_by_reorg";
  reorgCorrectionNote?: string;
}

export interface ReorgAuditEvent {
  eventId: string;
  ledgerSeq: number;
  previousHash: string;
  newHash: string;
  invalidatedReadingIds: string[];
  supersededDecisionIds: string[];
  detectedAtMs: number;
}

export class HorizonFinalityEvaluator {
  private readonly confirmationDepth: number;
  private readonly ledgerHashes = new Map<number, string>();
  private readonly readings = new Map<string, HorizonDerivedReading>();
  private readonly decisions = new Map<string, FinalityTrackedDecision>();
  private readonly reorgEvents: ReorgAuditEvent[] = [];
  private safeCheckpointLedger = 0;
  private seq = 0;

  constructor(options?: {
    confirmationDepth?: number;
    initialSafeCheckpointLedger?: number;
  }) {
    this.confirmationDepth = Math.max(1, options?.confirmationDepth ?? 3);
    this.safeCheckpointLedger = options?.initialSafeCheckpointLedger ?? 0;
  }

  public ingestHorizonReading(params: {
    feedId: string;
    value: number;
    ledgerSeq: number;
    ledgerHash: string;
    latestNetworkLedger: number;
    observedAtMs: number;
  }): {
    reading: HorizonDerivedReading;
    reorgDetected: boolean;
  } {
    let reorgDetected = false;
    const prevHash = this.ledgerHashes.get(params.ledgerSeq);

    if (prevHash && prevHash !== params.ledgerHash) {
      reorgDetected = true;
      this.handleLedgerReorg(
        params.ledgerSeq,
        prevHash,
        params.ledgerHash,
        params.observedAtMs
      );
    }

    this.ledgerHashes.set(params.ledgerSeq, params.ledgerHash);

    const isConfirmed =
      params.latestNetworkLedger - params.ledgerSeq >= this.confirmationDepth;
    const finalityStatus: ReadingFinalityStatus = isConfirmed
      ? "final"
      : "provisional";

    this.seq += 1;
    const reading: HorizonDerivedReading = {
      readingId: `hrz-read-${this.seq}`,
      feedId: params.feedId,
      value: params.value,
      ledgerSeq: params.ledgerSeq,
      ledgerHash: params.ledgerHash,
      observedAtMs: params.observedAtMs,
      finalityStatus,
    };

    this.readings.set(reading.readingId, reading);
    this.advanceFinalityWindow(params.latestNetworkLedger);

    return {
      reading: { ...this.readings.get(reading.readingId)! },
      reorgDetected,
    };
  }

  public advanceFinalityWindow(latestNetworkLedger: number): number {
    const maxFinalLedger = latestNetworkLedger - this.confirmationDepth;
    let promotedCount = 0;

    for (const r of this.readings.values()) {
      if (
        r.finalityStatus === "provisional" &&
        r.ledgerSeq <= maxFinalLedger &&
        this.ledgerHashes.get(r.ledgerSeq) === r.ledgerHash
      ) {
        r.finalityStatus = "final";
        promotedCount += 1;
      }
      if (
        r.finalityStatus === "final" &&
        r.ledgerSeq > this.safeCheckpointLedger
      ) {
        this.safeCheckpointLedger = r.ledgerSeq;
      }
    }

    return promotedCount;
  }

  public registerDecision(params: {
    decisionId: string;
    feedId: string;
    agreedValue: number;
    contributingReadingIds: string[];
  }): FinalityTrackedDecision {
    const decision: FinalityTrackedDecision = {
      decisionId: params.decisionId,
      feedId: params.feedId,
      agreedValue: params.agreedValue,
      contributingReadingIds: [...params.contributingReadingIds],
      status: "valid",
    };
    this.decisions.set(decision.decisionId, decision);
    return { ...decision };
  }

  public getQuorumEligibleReadings(feedId: string): HorizonDerivedReading[] {
    const list: HorizonDerivedReading[] = [];
    for (const r of this.readings.values()) {
      if (r.feedId === feedId && r.finalityStatus === "final") {
        list.push({ ...r });
      }
    }
    return list;
  }

  public getReading(readingId: string): HorizonDerivedReading | undefined {
    const r = this.readings.get(readingId);
    return r ? { ...r } : undefined;
  }

  public getDecision(decisionId: string): FinalityTrackedDecision | undefined {
    const d = this.decisions.get(decisionId);
    return d ? { ...d } : undefined;
  }

  public getSafeResumeCheckpointLedger(): number {
    return this.safeCheckpointLedger;
  }

  public getReorgAuditEvents(): ReorgAuditEvent[] {
    return this.reorgEvents.map((e) => ({ ...e }));
  }

  private handleLedgerReorg(
    forkedLedgerSeq: number,
    previousHash: string,
    newHash: string,
    nowMs: number
  ): void {
    const invalidatedReadingIds: string[] = [];
    for (const r of this.readings.values()) {
      if (
        r.ledgerSeq >= forkedLedgerSeq &&
        r.finalityStatus !== "invalidated_by_reorg"
      ) {
        r.finalityStatus = "invalidated_by_reorg";
        r.invalidatedReason = `Ledger reorg at seq ${forkedLedgerSeq}: hash ${previousHash} -> ${newHash}`;
        invalidatedReadingIds.push(r.readingId);
      }
    }

    const invalidatedSet = new Set(invalidatedReadingIds);
    const supersededDecisionIds: string[] = [];
    for (const d of this.decisions.values()) {
      if (
        d.status === "valid" &&
        d.contributingReadingIds.some((rid) => invalidatedSet.has(rid))
      ) {
        d.status = "superseded_by_reorg";
        d.reorgCorrectionNote = `Superseded due to ledger reorg at sequence ${forkedLedgerSeq}`;
        supersededDecisionIds.push(d.decisionId);
      }
    }

    // Roll back safe checkpoint to the last unaffected ledger before the fork
    let highestValidFinalLedger = 0;
    for (const r of this.readings.values()) {
      if (
        r.finalityStatus === "final" &&
        r.ledgerSeq < forkedLedgerSeq &&
        r.ledgerSeq > highestValidFinalLedger
      ) {
        highestValidFinalLedger = r.ledgerSeq;
      }
    }
    this.safeCheckpointLedger = highestValidFinalLedger;

    this.seq += 1;
    this.reorgEvents.push({
      eventId: `reorg-${this.seq}`,
      ledgerSeq: forkedLedgerSeq,
      previousHash,
      newHash,
      invalidatedReadingIds,
      supersededDecisionIds,
      detectedAtMs: nowMs,
    });
  }
}
