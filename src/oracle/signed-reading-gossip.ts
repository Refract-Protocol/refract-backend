import { createPublicKey, verify } from 'node:crypto';
import type { OracleReading, Severity } from './oracle-reading';

export interface SignedReadingEnvelope {
  version: 1;
  peerId: string;
  sequence: number;
  roundId: string;
  issuedAt: number;
  coverageType: string;
  value: number;
  threshold: number;
  severity: Severity;
  message: string;
  signature: string;
}

export interface CorroboratedReading {
  reading: OracleReading;
  roundId: string;
  peerIds: string[];
}

export interface SignedReadingGossipConfig {
  peers: Record<string, string>;
  minimumPeers: number;
  toleranceByCoverage: Record<string, number>;
  maximumMessageAgeMs: number;
  maximumFutureSkewMs: number;
  maximumEnvelopeBytes: number;
  maximumPendingRounds: number;
}

export interface GossipReplayGuard {
  /**
   * Atomically reserve the peer sequence and round. Implementations must
   * durably reject sequences not greater than the peer's previous sequence
   * and duplicate (peerId, roundId) pairs.
   */
  reserve(
    peerId: string,
    sequence: number,
    roundId: string,
    expiresAt: number,
  ): Promise<boolean>;
}

const ALLOWED_COVERAGE = new Set([
  'StablecoinDepeg',
  'MarketCrash',
  'LiquidationShield',
  'SmartContractRisk',
  'FlightDelay',
]);
const ALLOWED_SEVERITY = new Set<Severity>([
  'low',
  'medium',
  'high',
  'triggered',
]);
const MAX_PEERS = 32;
const MAX_VALUE = 1e12;

/**
 * Authenticates allowlisted oracle peers and only emits a reading after a
 * unique, quorum-sized cluster agrees on its coverage, threshold, severity,
 * and value tolerance. This class never publishes a reading itself.
 */
export class SignedReadingGossip {
  private readonly peers: Map<string, ReturnType<typeof createPublicKey>>;
  private readonly pending = new Map<string, SignedReadingEnvelope[]>();
  private readonly finalizedRounds = new Set<string>();
  private readonly config: SignedReadingGossipConfig;

  constructor(
    config: SignedReadingGossipConfig,
    private readonly replayGuard: GossipReplayGuard,
  ) {
    const peerEntries = Object.entries(config.peers);
    if (
      peerEntries.length < 2 ||
      peerEntries.length > MAX_PEERS ||
      !Number.isInteger(config.minimumPeers) ||
      config.minimumPeers < 2 ||
      config.minimumPeers > peerEntries.length ||
      config.maximumEnvelopeBytes < 256 ||
      config.maximumEnvelopeBytes > 16_384 ||
      config.maximumPendingRounds < 1 ||
      config.maximumPendingRounds > 1_024 ||
      config.maximumMessageAgeMs < 1 ||
      config.maximumFutureSkewMs < 0
    ) {
      throw new Error('Invalid signed reading gossip configuration');
    }

    this.peers = new Map(
      peerEntries.map(([peerId, publicKey]) => {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(peerId)) {
          throw new Error('Invalid configured peer identifier');
        }
        return [peerId, createPublicKey(publicKey)];
      }),
    );
    for (const [coverageType, tolerance] of Object.entries(
      config.toleranceByCoverage,
    )) {
      if (
        !ALLOWED_COVERAGE.has(coverageType) ||
        !Number.isFinite(tolerance) ||
        tolerance < 0
      ) {
        throw new Error('Invalid configured gossip tolerance');
      }
    }
    this.config = config;
  }

  async accept(
    envelope: SignedReadingEnvelope,
    now = Date.now(),
  ): Promise<CorroboratedReading | null> {
    if (!this.isValidEnvelope(envelope, now)) {
      throw new Error('Invalid signed reading envelope');
    }
    const serialized = canonicalReading(envelope);
    if (
      Buffer.byteLength(serialized, 'utf8') +
        Buffer.byteLength(envelope.signature, 'utf8') >
      this.config.maximumEnvelopeBytes
    ) {
      throw new Error('Signed reading envelope exceeds configured size limit');
    }

    const publicKey = this.peers.get(envelope.peerId);
    if (!publicKey) {
      throw new Error('Unknown oracle peer');
    }
    const signature = decodeSignature(envelope.signature);
    if (!verify(null, Buffer.from(serialized, 'utf8'), publicKey, signature)) {
      throw new Error('Invalid oracle peer signature');
    }
    if (this.finalizedRounds.has(envelope.roundId)) {
      throw new Error('Oracle consensus round is already finalized');
    }

    const round = this.pending.get(envelope.roundId);
    if (!round && this.pending.size >= this.config.maximumPendingRounds) {
      this.pruneExpired(now);
      if (this.pending.size >= this.config.maximumPendingRounds) {
        throw new Error('Oracle gossip pending-round capacity reached');
      }
    }

    const entries = this.pending.get(envelope.roundId) ?? [];
    if (
      entries.some(
        (entry) =>
          entry.peerId === envelope.peerId ||
          (entry.coverageType !== envelope.coverageType),
      )
    ) {
      throw new Error('Duplicate peer or mismatched coverage in consensus round');
    }

    const reserved = await this.replayGuard.reserve(
      envelope.peerId,
      envelope.sequence,
      envelope.roundId,
      envelope.issuedAt + this.config.maximumMessageAgeMs,
    );
    if (!reserved) {
      throw new Error('Replayed or out-of-order oracle peer sequence');
    }

    entries.push({ ...envelope });
    this.pending.set(envelope.roundId, entries);

    const consensus = this.findUniqueConsensus(envelope.roundId, entries);
    if (!consensus) {
      return null;
    }

    this.pending.delete(envelope.roundId);
    this.finalizedRounds.add(envelope.roundId);
    if (this.finalizedRounds.size > 4_096) {
      const oldest = this.finalizedRounds.values().next().value as string | undefined;
      if (oldest) this.finalizedRounds.delete(oldest);
    }
    return consensus;
  }

  private findUniqueConsensus(
    roundId: string,
    entries: SignedReadingEnvelope[],
  ): CorroboratedReading | null {
    const tolerance =
      this.config.toleranceByCoverage[entries[0]?.coverageType] ?? 0;
    const groups = new Map<string, SignedReadingEnvelope[]>();

    for (const candidate of entries) {
      const matching = entries.filter(
        (other) =>
          other.coverageType === candidate.coverageType &&
          other.threshold === candidate.threshold &&
          other.severity === candidate.severity &&
          Math.abs(other.value - candidate.value) <= tolerance,
      );
      if (matching.length >= this.config.minimumPeers) {
        const key = matching
          .map((entry) => entry.peerId)
          .sort()
          .join(',');
        groups.set(key, matching);
      }
    }

    if (groups.size !== 1) {
      return null;
    }

    const matching = [...groups.values()][0];
    const values = matching.map((entry) => entry.value).sort((a, b) => a - b);
    const median = values[Math.floor(values.length / 2)];
    return {
      roundId,
      peerIds: matching.map((entry) => entry.peerId).sort(),
      reading: {
        coverageType: matching[0].coverageType,
        type: 'oracle_update',
        value: median,
        threshold: matching[0].threshold,
        severity: matching[0].severity,
        message: `Corroborated by ${matching.length} independently signed oracle peers`,
      },
    };
  }

  private isValidEnvelope(
    envelope: SignedReadingEnvelope,
    now: number,
  ): boolean {
    if (!envelope || typeof envelope !== 'object') return false;
    if (
      envelope.version !== 1 ||
      typeof envelope.peerId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(envelope.peerId) ||
      !Number.isSafeInteger(envelope.sequence) ||
      envelope.sequence < 1 ||
      typeof envelope.roundId !== 'string' ||
      !/^[A-Za-z0-9:_-]{1,96}$/.test(envelope.roundId) ||
      !Number.isSafeInteger(envelope.issuedAt) ||
      envelope.issuedAt < now - this.config.maximumMessageAgeMs ||
      envelope.issuedAt > now + this.config.maximumFutureSkewMs ||
      !ALLOWED_COVERAGE.has(envelope.coverageType) ||
      !Number.isFinite(envelope.value) ||
      Math.abs(envelope.value) > MAX_VALUE ||
      !Number.isFinite(envelope.threshold) ||
      Math.abs(envelope.threshold) > MAX_VALUE ||
      !ALLOWED_SEVERITY.has(envelope.severity) ||
      typeof envelope.message !== 'string' ||
      Buffer.byteLength(envelope.message, 'utf8') > 512 ||
      typeof envelope.signature !== 'string' ||
      envelope.signature.length > 128
    ) {
      return false;
    }
    return true;
  }

  private pruneExpired(now: number): void {
    const staleBefore = now - this.config.maximumMessageAgeMs;
    for (const [roundId, entries] of this.pending) {
      const live = entries.filter((entry) => entry.issuedAt >= staleBefore);
      if (live.length === 0) {
        this.pending.delete(roundId);
      } else {
        this.pending.set(roundId, live);
      }
    }
  }
}

/** Stable signed representation; no JSON property-order dependence. */
export function canonicalReading(envelope: SignedReadingEnvelope): string {
  return JSON.stringify([
    envelope.version,
    envelope.peerId,
    envelope.sequence,
    envelope.roundId,
    envelope.issuedAt,
    envelope.coverageType,
    envelope.value,
    envelope.threshold,
    envelope.severity,
    envelope.message,
  ]);
}

function decodeSignature(signature: string): Buffer {
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)) {
    throw new Error('Invalid oracle peer signature encoding');
  }
  const decoded = Buffer.from(signature, 'base64');
  if (decoded.length !== 64 || decoded.toString('base64') !== signature) {
    throw new Error('Invalid oracle peer signature encoding');
  }
  return decoded;
}
