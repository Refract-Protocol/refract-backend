import { createHash } from "node:crypto";

export interface EvidenceLedgerEntry {
  sequenceNumber: number;
  recordId: string;
  feedId: string;
  stage: string;
  payloadHash: string;
  observedAtMs: number;
}

export interface MerkleProofStep {
  position: "left" | "right";
  siblingHash: string;
}

export interface OnChainAnchorReceipt {
  fromSequence: number;
  toSequence: number;
  merkleRoot: string;
  txHash: string;
  sorobanLedger: number;
  anchoredAtMs: number;
}

export interface EvidenceInclusionVerification {
  recordId: string;
  leafHash: string;
  merkleRoot: string;
  proof: MerkleProofStep[];
  receipt: OnChainAnchorReceipt;
}

export class EvidenceMerkleAnchorService {
  private readonly entries: EvidenceLedgerEntry[] = [];
  private readonly receipts: OnChainAnchorReceipt[] = [];
  private readonly publishRootOnChain: (params: {
    fromSequence: number;
    toSequence: number;
    merkleRoot: string;
  }) => Promise<{ txHash: string; sorobanLedger: number }>;

  constructor(options: {
    publishRootOnChain: (params: {
      fromSequence: number;
      toSequence: number;
      merkleRoot: string;
    }) => Promise<{ txHash: string; sorobanLedger: number }>;
  }) {
    this.publishRootOnChain = options.publishRootOnChain;
  }

  public static computeLeafHash(entry: EvidenceLedgerEntry): string {
    const canonical = JSON.stringify({
      sequenceNumber: entry.sequenceNumber,
      recordId: entry.recordId,
      feedId: entry.feedId,
      stage: entry.stage,
      payloadHash: entry.payloadHash,
      observedAtMs: entry.observedAtMs,
    });
    return createHash("sha256").update(`leaf:${canonical}`).digest("hex");
  }

  public static combinePairHash(leftHex: string, rightHex: string): string {
    return createHash("sha256")
      .update(`node:${leftHex}:${rightHex}`)
      .digest("hex");
  }

  public appendLedgerEntry(entry: EvidenceLedgerEntry): void {
    const expectedSeq =
      this.entries.length === 0
        ? 1
        : this.entries[this.entries.length - 1]!.sequenceNumber + 1;
    if (entry.sequenceNumber !== expectedSeq) {
      throw new Error(
        `NON_CONTIGUOUS_SEQUENCE: Expected sequence ${expectedSeq}, got ${entry.sequenceNumber}`
      );
    }
    this.entries.push({ ...entry });
  }

  /**
   * Anchors the next contiguous unanchored range `[lastAnchored + 1 .. upToSequence]`.
   * Idempotent if the range has no new entries.
   */
  public async anchorNextUnanchoredRange(
    nowMs: number = Date.now()
  ): Promise<OnChainAnchorReceipt | null> {
    const lastReceipt =
      this.receipts.length > 0 ? this.receipts[this.receipts.length - 1]! : null;
    const nextFromSeq = lastReceipt ? lastReceipt.toSequence + 1 : 1;

    const batchEntries = this.entries.filter(
      (e) => e.sequenceNumber >= nextFromSeq
    );
    if (batchEntries.length === 0) {
      return null;
    }

    const fromSequence = batchEntries[0]!.sequenceNumber;
    const toSequence = batchEntries[batchEntries.length - 1]!.sequenceNumber;
    const leafHashes = batchEntries.map((e) =>
      EvidenceMerkleAnchorService.computeLeafHash(e)
    );
    const merkleRoot = EvidenceMerkleAnchorService.computeRootFromLeaves(
      leafHashes
    );

    const onChain = await this.publishRootOnChain({
      fromSequence,
      toSequence,
      merkleRoot,
    });

    const receipt: OnChainAnchorReceipt = {
      fromSequence,
      toSequence,
      merkleRoot,
      txHash: onChain.txHash,
      sorobanLedger: onChain.sorobanLedger,
      anchoredAtMs: nowMs,
    };
    this.receipts.push(receipt);
    return receipt;
  }

  public buildInclusionProof(
    recordId: string
  ): EvidenceInclusionVerification | null {
    const entry = this.entries.find((e) => e.recordId === recordId);
    if (!entry) return null;

    const receipt = this.receipts.find(
      (r) =>
        entry.sequenceNumber >= r.fromSequence &&
        entry.sequenceNumber <= r.toSequence
    );
    if (!receipt) return null;

    const rangeEntries = this.entries.filter(
      (e) =>
        e.sequenceNumber >= receipt.fromSequence &&
        e.sequenceNumber <= receipt.toSequence
    );
    const leaves = rangeEntries.map((e) =>
      EvidenceMerkleAnchorService.computeLeafHash(e)
    );
    const targetIdx = rangeEntries.findIndex((e) => e.recordId === recordId);
    if (targetIdx < 0) return null;

    const proof = EvidenceMerkleAnchorService.computeMerkleProofForIndex(
      leaves,
      targetIdx
    );

    return {
      recordId,
      leafHash: leaves[targetIdx]!,
      merkleRoot: receipt.merkleRoot,
      proof,
      receipt,
    };
  }

  public static verifyEntryAgainstProof(
    entry: EvidenceLedgerEntry,
    proof: MerkleProofStep[],
    expectedMerkleRoot: string
  ): boolean {
    let current = EvidenceMerkleAnchorService.computeLeafHash(entry);
    for (const step of proof) {
      if (step.position === "left") {
        current = EvidenceMerkleAnchorService.combinePairHash(
          step.siblingHash,
          current
        );
      } else {
        current = EvidenceMerkleAnchorService.combinePairHash(
          current,
          step.siblingHash
        );
      }
    }
    return current === expectedMerkleRoot;
  }

  public static computeRootFromLeaves(leafHashes: string[]): string {
    if (leafHashes.length === 0) {
      return createHash("sha256").update("empty").digest("hex");
    }
    let level = [...leafHashes];
    while (level.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i]!;
        const right = i + 1 < level.length ? level[i + 1]! : left;
        next.push(EvidenceMerkleAnchorService.combinePairHash(left, right));
      }
      level = next;
    }
    return level[0]!;
  }

  public static computeMerkleProofForIndex(
    leafHashes: string[],
    targetIndex: number
  ): MerkleProofStep[] {
    const proof: MerkleProofStep[] = [];
    let level = [...leafHashes];
    let idx = targetIndex;

    while (level.length > 1) {
      const isRightNode = idx % 2 === 1;
      const siblingIdx = isRightNode
        ? idx - 1
        : idx + 1 < level.length
          ? idx + 1
          : idx;
      proof.push({
        position: isRightNode ? "left" : "right",
        siblingHash: level[siblingIdx]!,
      });

      const next: string[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i]!;
        const right = i + 1 < level.length ? level[i + 1]! : left;
        next.push(EvidenceMerkleAnchorService.combinePairHash(left, right));
      }
      level = next;
      idx = Math.floor(idx / 2);
    }

    return proof;
  }
}
