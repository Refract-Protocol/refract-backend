/**
 * Remembers webhook nonces until they can no longer pass the timestamp check,
 * so a captured request can't be replayed inside the skew window.
 *
 * Single-instance only. Running several API replicas behind a load balancer
 * needs a shared store (e.g. Redis SET NX PX) behind the same interface.
 */
export interface NonceStore {
  /**
   * Records `key` until `expiresAt` (epoch ms). Returns "fresh" the first time,
   * "replayed" if it is already recorded and unexpired, and "full" if the
   * store can't take it.
   */
  claim(key: string, expiresAt: number, now: number): "fresh" | "replayed" | "full";
}

export class InMemoryNonceStore implements NonceStore {
  private readonly entries = new Map<string, number>();

  constructor(private readonly capacity = 100_000) {}

  claim(key: string, expiresAt: number, now: number): "fresh" | "replayed" | "full" {
    const existing = this.entries.get(key);
    if (existing !== undefined && existing > now) return "replayed";
    if (existing === undefined && this.entries.size >= this.capacity) {
      this.sweep(now);
      // Fail closed. Evicting a live nonce to make room would let it be replayed.
      if (this.entries.size >= this.capacity) return "full";
    }
    this.entries.set(key, expiresAt);
    return "fresh";
  }

  size(): number {
    return this.entries.size;
  }

  private sweep(now: number): void {
    for (const [k, exp] of this.entries) if (exp <= now) this.entries.delete(k);
  }
}
