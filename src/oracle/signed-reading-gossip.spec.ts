import { generateKeyPairSync, sign } from 'node:crypto';
import {
  canonicalReading,
  GossipReplayGuard,
  SignedReadingEnvelope,
  SignedReadingGossip,
} from './signed-reading-gossip';

const NOW = 1_800_000_000_000;

function peerKeys(): Map<
  string,
  { privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']; publicKey: string }
> {
  const peers = new Map();
  for (const peerId of ['node-a', 'node-b', 'node-c']) {
    const pair = generateKeyPairSync('ed25519');
    peers.set(peerId, {
      privateKey: pair.privateKey,
      publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    });
  }
  return peers;
}

function signed(
  peerId: string,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  overrides: Partial<SignedReadingEnvelope> = {},
): SignedReadingEnvelope {
  const payload: SignedReadingEnvelope = {
    version: 1,
    peerId,
    sequence: 1,
    roundId: 'round-1',
    issuedAt: NOW,
    coverageType: 'StablecoinDepeg',
    value: 0.999,
    threshold: 0.95,
    severity: 'low',
    message: 'healthy',
    signature: '',
    ...overrides,
  };
  payload.signature = sign(
    null,
    Buffer.from(canonicalReading(payload), 'utf8'),
    privateKey,
  ).toString('base64');
  return payload;
}

describe('SignedReadingGossip', () => {
  function createGossip(peers: ReturnType<typeof peerKeys>) {
    return new SignedReadingGossip({
      peers: Object.fromEntries(
        [...peers].map(([id, keys]) => [id, keys.publicKey]),
      ),
      minimumPeers: 2,
      toleranceByCoverage: { StablecoinDepeg: 0.01 },
      maximumMessageAgeMs: 60_000,
      maximumFutureSkewMs: 5_000,
      maximumEnvelopeBytes: 4096,
      maximumPendingRounds: 8,
    }, new MemoryReplayGuard());
  }

  it('emits a consensus decision only after independent signatures meet quorum', async () => {
    const peers = peerKeys();
    const gossip = createGossip(peers);
    const first = signed('node-a', peers.get('node-a')!.privateKey);
    const second = signed('node-b', peers.get('node-b')!.privateKey, {
      value: 1.001,
    });

    expect(await gossip.accept(first, NOW)).toBeNull();
    const consensus = await gossip.accept(second, NOW);
    expect(consensus?.peerIds).toEqual(['node-a', 'node-b']);
    expect(consensus?.reading.value).toBe(1.001);
    expect(consensus?.reading.message).toContain('2 independently signed');
    await expect(gossip.accept(first, NOW)).rejects.toThrow('finalized');
  });

  it('rejects unauthenticated, altered, expired, and replayed messages', async () => {
    const peers = peerKeys();
    const gossip = createGossip(peers);
    const envelope = signed('node-a', peers.get('node-a')!.privateKey);
    await expect(
      gossip.accept({ ...envelope, value: 0.5 }, NOW),
    ).rejects.toThrow('signature');
    await expect(
      gossip.accept(
        signed('node-a', peers.get('node-a')!.privateKey, {
          issuedAt: NOW - 60_001,
          roundId: 'old-round',
        }),
        NOW,
      ),
    ).rejects.toThrow('envelope');
    await gossip.accept(envelope, NOW);
    await expect(gossip.accept(envelope, NOW)).rejects.toThrow('sequence');
    await expect(
      gossip.accept(
        signed('unauthorized', peers.get('node-a')!.privateKey, {
          roundId: 'unknown-peer-round',
        }),
        NOW,
      ),
    ).rejects.toThrow('Unknown oracle peer');
  });

  it('does not resolve a round when peers disagree on decision or value', async () => {
    const peers = peerKeys();
    const gossip = createGossip(peers);
    await gossip.accept(signed('node-a', peers.get('node-a')!.privateKey), NOW);
    expect(
      await gossip.accept(
        signed('node-b', peers.get('node-b')!.privateKey, {
          value: 0.8,
          severity: 'triggered',
        }),
        NOW,
      ),
    ).toBeNull();
  });

  it('rejects oversized envelopes and bounds pending round state', async () => {
    const peers = peerKeys();
    const gossip = createGossip(peers);
    await expect(
      gossip.accept(
        signed('node-a', peers.get('node-a')!.privateKey, {
          message: 'x'.repeat(513),
        }),
        NOW,
      ),
    ).rejects.toThrow('envelope');

    for (let i = 0; i < 8; i++) {
      await gossip.accept(
        signed('node-a', peers.get('node-a')!.privateKey, {
          sequence: i + 1,
          roundId: `pending-${i}`,
        }),
        NOW,
      );
    }
    await expect(
      gossip.accept(
        signed('node-a', peers.get('node-a')!.privateKey, {
          sequence: 9,
          roundId: 'overflow',
        }),
        NOW,
      ),
    ).rejects.toThrow('capacity');
  });
});

class MemoryReplayGuard implements GossipReplayGuard {
  private readonly lastSequence = new Map<string, number>();
  private readonly roundPeers = new Set<string>();

  async reserve(
    peerId: string,
    sequence: number,
    roundId: string,
  ): Promise<boolean> {
    const pair = `${peerId}:${roundId}`;
    if (
      sequence <= (this.lastSequence.get(peerId) ?? 0) ||
      this.roundPeers.has(pair)
    ) {
      return false;
    }
    this.lastSequence.set(peerId, sequence);
    this.roundPeers.add(pair);
    return true;
  }
}
