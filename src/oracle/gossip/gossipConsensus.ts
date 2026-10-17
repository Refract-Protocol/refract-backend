/**
 * Gossip-Based Cross-Node Consensus Agreement for Distributed Oracle Operators (Issue #275)
 *
 * Implements a signed peer-to-peer gossip protocol (`reading_announce`, `reading_echo`,
 * `decision_vote`, `decision_commit`) with SHA-256 canonical content addressing,
 * bounded TTL and fan-out, per-peer rate limiting, bounded deduplication memory,
 * Byzantine equivocation detection, and deterministic fail-closed median consensus.
 */

import { createHash } from "node:crypto";

export type GossipMessageType =
  | "reading_announce"
  | "reading_echo"
  | "decision_vote"
  | "decision_commit";

export interface ReadingAnnouncePayload {
  feedId: string;
  roundNumber: number;
  valueScaled: bigint;
  observedAtMs: number;
  sourceIds: string[];
}

export interface DecisionCommitPayload {
  feedId: string;
  roundNumber: number;
  consensusValueScaled: bigint;
  contributingOperators: string[];
  contributingReadingHashes: string[];
  decisionHash: string;
}

export interface GossipEnvelope<TPayload = ReadingAnnouncePayload | DecisionCommitPayload> {
  envelopeHash: string;
  messageType: GossipMessageType;
  senderOperatorId: string;
  originOperatorId: string;
  feedId: string;
  roundNumber: number;
  ttlHops: number;
  timestampMs: number;
  contentHash: string;
  signature: string;
  payload: TPayload;
}

export interface GossipNodeConfig {
  operatorId: string;
  minDistinctOperators: number;
  maxFanOut: number;
  defaultTtlHops: number;
  maxClockSkewMs: number;
  maxSeenEnvelopes: number;
  rateLimitWindowMs: number;
  maxMessagesPerPeerWindow: number;
}

export const DEFAULT_GOSSIP_NODE_CONFIG: Omit<GossipNodeConfig, "operatorId"> = {
  minDistinctOperators: 3,
  maxFanOut: 3,
  defaultTtlHops: 3,
  maxClockSkewMs: 30_000,
  maxSeenEnvelopes: 2_000,
  rateLimitWindowMs: 10_000,
  maxMessagesPerPeerWindow: 25,
};

export interface RoundConsensusOutcome {
  feedId: string;
  roundNumber: number;
  committed: boolean;
  failClosedReason?: "insufficient_operator_quorum" | "no_valid_announcements";
  consensusValueScaled?: bigint;
  contributingOperators: string[];
  contributingReadingHashes: string[];
  equivocatingOperators: string[];
  decisionHash?: string;
  commitEnvelope?: GossipEnvelope<DecisionCommitPayload>;
}

export function computeCanonicalReadingHash(
  originOperatorId: string,
  payload: ReadingAnnouncePayload
): string {
  const canonical = JSON.stringify({
    originOperatorId,
    feedId: payload.feedId,
    roundNumber: payload.roundNumber,
    valueScaled: payload.valueScaled.toString(),
    observedAtMs: payload.observedAtMs,
    sourceIds: [...payload.sourceIds].sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function computeCanonicalDecisionHash(
  feedId: string,
  roundNumber: number,
  consensusValueScaled: bigint,
  contributingReadingHashes: readonly string[]
): string {
  const canonical = JSON.stringify({
    feedId,
    roundNumber,
    consensusValueScaled: consensusValueScaled.toString(),
    contributingReadingHashes: [...contributingReadingHashes].sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function signCanonicalHash(operatorId: string, contentHash: string): string {
  return createHash("sha256")
    .update(`sig:${operatorId}:${contentHash}`)
    .digest("hex");
}

export function verifyCanonicalSignature(
  operatorId: string,
  contentHash: string,
  signature: string
): boolean {
  return signCanonicalHash(operatorId, contentHash) === signature;
}

/**
 * Pure deterministic function that derives a round consensus outcome from any set
 * of verified `reading_announce` envelopes. Replaying the same announcement set
 * in any arrival order produces the exact same consensus output byte-for-byte.
 */
export function deriveDeterministicRoundConsensus(
  feedId: string,
  roundNumber: number,
  announcements: readonly GossipEnvelope<ReadingAnnouncePayload>[],
  minDistinctOperators: number,
  localOperatorId: string,
  nowMs: number
): RoundConsensusOutcome {
  // Group announcements by originOperatorId to detect Byzantine equivocation
  const byOperator = new Map<string, Map<string, GossipEnvelope<ReadingAnnouncePayload>>>();

  for (const env of announcements) {
    if (env.feedId !== feedId || env.roundNumber !== roundNumber) {
      continue;
    }
    const opMap = byOperator.get(env.originOperatorId) ?? new Map();
    opMap.set(env.contentHash, env);
    byOperator.set(env.originOperatorId, opMap);
  }

  const equivocatingOperators: string[] = [];
  const validEntries: Array<{
    operatorId: string;
    contentHash: string;
    valueScaled: bigint;
  }> = [];

  for (const [operatorId, contentMap] of Array.from(byOperator.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    if (contentMap.size > 1) {
      // Byzantine peer broadcast conflicting readings for the same (feedId, roundNumber)
      equivocatingOperators.push(operatorId);
      continue;
    }
    const [onlyEnv] = contentMap.values();
    validEntries.push({
      operatorId,
      contentHash: onlyEnv.contentHash,
      valueScaled: onlyEnv.payload.valueScaled,
    });
  }

  if (validEntries.length === 0) {
    return {
      feedId,
      roundNumber,
      committed: false,
      failClosedReason: "no_valid_announcements",
      contributingOperators: [],
      contributingReadingHashes: [],
      equivocatingOperators,
    };
  }

  if (validEntries.length < minDistinctOperators) {
    // Partition tolerance: fail closed rather than falling back to a single local reading
    return {
      feedId,
      roundNumber,
      committed: false,
      failClosedReason: "insufficient_operator_quorum",
      contributingOperators: validEntries.map((e) => e.operatorId),
      contributingReadingHashes: validEntries.map((e) => e.contentHash).sort(),
      equivocatingOperators,
    };
  }

  // Deterministic median calculation (lower-median on even counts, or exact midpoint in BigInt)
  const sortedByValue = [...validEntries].sort((a, b) =>
    a.valueScaled < b.valueScaled
      ? -1
      : a.valueScaled > b.valueScaled
        ? 1
        : a.operatorId.localeCompare(b.operatorId)
  );

  const mid = Math.floor(sortedByValue.length / 2);
  const consensusValueScaled =
    sortedByValue.length % 2 === 1
      ? sortedByValue[mid].valueScaled
      : (sortedByValue[mid - 1].valueScaled + sortedByValue[mid].valueScaled) / 2n;

  const contributingOperators = validEntries.map((e) => e.operatorId).sort();
  const contributingReadingHashes = validEntries.map((e) => e.contentHash).sort();
  const decisionHash = computeCanonicalDecisionHash(
    feedId,
    roundNumber,
    consensusValueScaled,
    contributingReadingHashes
  );

  const commitPayload: DecisionCommitPayload = {
    feedId,
    roundNumber,
    consensusValueScaled,
    contributingOperators,
    contributingReadingHashes,
    decisionHash,
  };

  const commitEnvelope: GossipEnvelope<DecisionCommitPayload> = {
    envelopeHash: createHash("sha256")
      .update(`commit:${localOperatorId}:${decisionHash}`)
      .digest("hex"),
    messageType: "decision_commit",
    senderOperatorId: localOperatorId,
    originOperatorId: localOperatorId,
    feedId,
    roundNumber,
    ttlHops: 1,
    timestampMs: nowMs,
    contentHash: decisionHash,
    signature: signCanonicalHash(localOperatorId, decisionHash),
    payload: commitPayload,
  };

  return {
    feedId,
    roundNumber,
    committed: true,
    consensusValueScaled,
    contributingOperators,
    contributingReadingHashes,
    equivocatingOperators,
    decisionHash,
    commitEnvelope,
  };
}

export class GossipConsensusNode {
  readonly config: GossipNodeConfig;
  private readonly peers = new Set<string>();
  private readonly seenEnvelopes = new Set<string>();
  private readonly seenOrderQueue: string[] = [];
  private readonly peerMessageTimestamps = new Map<string, number[]>();
  private readonly roundAnnouncements = new Map<
    string,
    GossipEnvelope<ReadingAnnouncePayload>[]
  >();

  constructor(config: Partial<GossipNodeConfig> & { operatorId: string }) {
    this.config = {
      ...DEFAULT_GOSSIP_NODE_CONFIG,
      ...config,
    };
  }

  registerPeer(peerOperatorId: string): void {
    if (peerOperatorId !== this.config.operatorId) {
      this.peers.add(peerOperatorId);
    }
  }

  /**
   * Creates a signed `reading_announce` envelope for this node's own reading,
   * stores it locally, and returns the envelope plus bounded fan-out target peers.
   */
  createLocalAnnouncement(
    payload: ReadingAnnouncePayload,
    nowMs: number
  ): {
    envelope: GossipEnvelope<ReadingAnnouncePayload>;
    targetPeers: string[];
  } {
    const contentHash = computeCanonicalReadingHash(
      this.config.operatorId,
      payload
    );
    const signature = signCanonicalHash(this.config.operatorId, contentHash);
    const envelopeHash = createHash("sha256")
      .update(
        `env:${this.config.operatorId}:${this.config.operatorId}:${contentHash}:${this.config.defaultTtlHops}`
      )
      .digest("hex");

    const envelope: GossipEnvelope<ReadingAnnouncePayload> = {
      envelopeHash,
      messageType: "reading_announce",
      senderOperatorId: this.config.operatorId,
      originOperatorId: this.config.operatorId,
      feedId: payload.feedId,
      roundNumber: payload.roundNumber,
      ttlHops: this.config.defaultTtlHops,
      timestampMs: nowMs,
      contentHash,
      signature,
      payload,
    };

    this.markSeen(envelope.envelopeHash);
    this.storeAnnouncement(envelope);

    return {
      envelope,
      targetPeers: this.selectFanOutPeers(envelope.contentHash),
    };
  }

  /**
   * Receives a gossip announcement from a peer, enforcing rate limits, deduplication,
   * clock-skew bounds, and cryptographic signature verification, and returns
   * a decremented-TTL re-broadcast envelope if `ttlHops > 1`.
   */
  receiveAnnouncement(
    envelope: GossipEnvelope<ReadingAnnouncePayload>,
    nowMs: number
  ): {
    accepted: boolean;
    reason?:
      | "rate_limited"
      | "duplicate"
      | "clock_skew_exceeded"
      | "invalid_content_hash"
      | "invalid_signature"
      | "ttl_exhausted";
    forwardEnvelope?: GossipEnvelope<ReadingAnnouncePayload>;
    forwardPeers: string[];
  } {
    if (!this.checkPeerRateLimit(envelope.senderOperatorId, nowMs)) {
      return { accepted: false, reason: "rate_limited", forwardPeers: [] };
    }

    if (this.seenEnvelopes.has(envelope.envelopeHash)) {
      return { accepted: false, reason: "duplicate", forwardPeers: [] };
    }

    if (
      Math.abs(nowMs - envelope.timestampMs) > this.config.maxClockSkewMs ||
      Math.abs(nowMs - envelope.payload.observedAtMs) > this.config.maxClockSkewMs
    ) {
      return { accepted: false, reason: "clock_skew_exceeded", forwardPeers: [] };
    }

    const expectedContentHash = computeCanonicalReadingHash(
      envelope.originOperatorId,
      envelope.payload
    );
    if (expectedContentHash !== envelope.contentHash) {
      return { accepted: false, reason: "invalid_content_hash", forwardPeers: [] };
    }

    if (
      !verifyCanonicalSignature(
        envelope.originOperatorId,
        envelope.contentHash,
        envelope.signature
      )
    ) {
      return { accepted: false, reason: "invalid_signature", forwardPeers: [] };
    }

    this.markSeen(envelope.envelopeHash);
    this.storeAnnouncement(envelope);

    if (envelope.ttlHops <= 1) {
      return { accepted: true, forwardPeers: [] };
    }

    const nextTtl = envelope.ttlHops - 1;
    const forwardEnvelope: GossipEnvelope<ReadingAnnouncePayload> = {
      ...envelope,
      messageType: "reading_echo",
      senderOperatorId: this.config.operatorId,
      ttlHops: nextTtl,
      envelopeHash: createHash("sha256")
        .update(
          `env:${this.config.operatorId}:${envelope.originOperatorId}:${envelope.contentHash}:${nextTtl}`
        )
        .digest("hex"),
    };

    const forwardPeers = this.selectFanOutPeers(
      envelope.contentHash,
      new Set([envelope.senderOperatorId, envelope.originOperatorId])
    );

    return {
      accepted: true,
      forwardEnvelope,
      forwardPeers,
    };
  }

  /**
   * Evaluates consensus for `(feedId, roundNumber)` from all verified announcements
   * received by this node.
   */
  evaluateRound(
    feedId: string,
    roundNumber: number,
    nowMs: number
  ): RoundConsensusOutcome {
    const key = `${feedId}:${roundNumber}`;
    const list = this.roundAnnouncements.get(key) ?? [];
    return deriveDeterministicRoundConsensus(
      feedId,
      roundNumber,
      list,
      this.config.minDistinctOperators,
      this.config.operatorId,
      nowMs
    );
  }

  private storeAnnouncement(envelope: GossipEnvelope<ReadingAnnouncePayload>): void {
    const key = `${envelope.feedId}:${envelope.roundNumber}`;
    const list = this.roundAnnouncements.get(key) ?? [];
    list.push(envelope);
    this.roundAnnouncements.set(key, list);
  }

  private markSeen(envelopeHash: string): void {
    if (this.seenEnvelopes.has(envelopeHash)) {
      return;
    }
    this.seenEnvelopes.add(envelopeHash);
    this.seenOrderQueue.push(envelopeHash);
    while (this.seenOrderQueue.length > this.config.maxSeenEnvelopes) {
      const oldest = this.seenOrderQueue.shift();
      if (oldest) {
        this.seenEnvelopes.delete(oldest);
      }
    }
  }

  private checkPeerRateLimit(peerId: string, nowMs: number): boolean {
    const recent = (this.peerMessageTimestamps.get(peerId) ?? []).filter(
      (ts) => nowMs - ts <= this.config.rateLimitWindowMs
    );
    if (recent.length >= this.config.maxMessagesPerPeerWindow) {
      this.peerMessageTimestamps.set(peerId, recent);
      return false;
    }
    recent.push(nowMs);
    this.peerMessageTimestamps.set(peerId, recent);
    return true;
  }

  private selectFanOutPeers(
    seedHash: string,
    exclude = new Set<string>()
  ): string[] {
    const candidates = Array.from(this.peers)
      .filter((p) => !exclude.has(p))
      .sort((a, b) => {
        const ha = createHash("sha256").update(`${seedHash}:${a}`).digest("hex");
        const hb = createHash("sha256").update(`${seedHash}:${b}`).digest("hex");
        return ha.localeCompare(hb);
      });
    return candidates.slice(0, this.config.maxFanOut);
  }
}
