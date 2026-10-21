import { ClaimHoldService } from "../claim-hold.service";
import { ConsensusConfig } from "../consensus.config";
import { ConsensusService } from "../consensus.service";
import { EvidenceLedger, PayloadStore } from "../evidence-ledger";

/** Shared test harness: a ledger with a manually advanced clock. */
export class ConsensusHarness {
  nowMs = 1_760_000_000_000;
  readonly ledger: EvidenceLedger;
  readonly payloads: PayloadStore;
  readonly config: ConsensusConfig;
  readonly consensus: ConsensusService;
  readonly holds: ClaimHoldService;

  constructor(opts: { ledgerPath?: string; payloadDir?: string; config?: Partial<ConsensusConfig> } = {}) {
    this.ledger = new EvidenceLedger(opts.ledgerPath, () => this.nowMs);
    this.payloads = new PayloadStore(opts.payloadDir);
    this.config = { holdReevaluateIntervalMs: 60_000, holdMaxDurationMs: 3_600_000, ...opts.config };
    this.consensus = new ConsensusService(this.ledger, this.payloads);
    this.holds = new ClaimHoldService(this.ledger, this.payloads, this.config, this.consensus);
  }

  advance(ms: number): void {
    this.nowMs += ms;
  }

  /** Three-source USDC peg feed; triggers when the price falls below 0.95. */
  seedFeed(feedId = "StablecoinDepeg", sources = ["coingecko", "kraken", "binance"], opts: { expectedSources?: number } = {}): void {
    for (const s of sources) {
      this.consensus.registerSource({ sourceId: s, providerId: s, feedId, weight: 1, retentionDays: 30 });
    }
    this.consensus.setQuorumPolicy({
      feedId,
      minSources: 2,
      expectedSources: opts.expectedSources ?? sources.length,
      minTotalWeight: 2,
      maxReadingAgeMs: 5 * 60_000,
      trigger: { op: "lt", threshold: 0.95 },
    });
  }

  read(sourceId: string, value: number, extra: { feedId?: string; payload?: string | null; signature?: "verified" | "pending" | "failed" | "not_required"; ledgerSeq?: number } = {}) {
    this.advance(1000);
    const payload = extra.payload === null ? undefined : (extra.payload ?? JSON.stringify({ source: sourceId, price: value, t: this.nowMs }));
    return this.consensus.recordReading({
      feedId: extra.feedId ?? "StablecoinDepeg",
      sourceId,
      value,
      observedAt: this.nowMs,
      ledgerSeq: extra.ledgerSeq,
      rawPayload: payload,
      signature: extra.signature,
    });
  }
}

export const candidate = (policyId = "pol-1", feedId = "StablecoinDepeg", expiresInMs = 30 * 86_400_000, now = 1_760_000_000_000) => ({
  policyId,
  holder: "GHOLDER",
  feedId,
  policyExpiresAt: now + expiresInMs,
});
