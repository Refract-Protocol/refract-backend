export type FeedControlScope = '*' | string;
export type OnChainPauseStatus = 'confirmed' | 'unconfirmed' | 'unavailable';

export interface OnChainPausePublisher {
  publishPause(
    scope: FeedControlScope,
    paused: boolean,
    reason: string,
  ): Promise<{ confirmed: boolean; txHash?: string }>;
}

export interface FeedControlSnapshot {
  scope: FeedControlScope;
  paused: boolean;
  reason: string | null;
  changedAt: number;
  onChainStatus: OnChainPauseStatus;
  txHash?: string;
}

/**
 * Fail-closed pause state for oracle publication. A pause is enforced locally
 * before attempting chain publication. A resume is not admitted locally until
 * the chain adapter confirms that the matching on-chain control was updated.
 */
export class OracleFeedControl {
  private readonly snapshots = new Map<FeedControlScope, FeedControlSnapshot>();

  constructor(private readonly publisher?: OnChainPausePublisher) {}

  isPaused(coverageType: string): boolean {
    return (
      this.snapshots.get('*')?.paused === true ||
      this.snapshots.get(coverageType)?.paused === true
    );
  }

  async pause(
    scope: FeedControlScope,
    reason: string,
    now = Date.now(),
  ): Promise<FeedControlSnapshot> {
    const snapshot: FeedControlSnapshot = {
      scope,
      paused: true,
      reason: reason.slice(0, 256),
      changedAt: now,
      onChainStatus: this.publisher ? 'unconfirmed' : 'unavailable',
    };
    this.snapshots.set(scope, snapshot);

    if (!this.publisher) {
      return { ...snapshot };
    }

    try {
      const published = await this.publisher.publishPause(scope, true, snapshot.reason);
      snapshot.onChainStatus = published.confirmed ? 'confirmed' : 'unconfirmed';
      snapshot.txHash = published.txHash;
    } catch {
      // Keep the local pause in force if chain submission fails.
      snapshot.onChainStatus = 'unconfirmed';
    }
    return { ...snapshot };
  }

  async resume(
    scope: FeedControlScope,
    now = Date.now(),
  ): Promise<FeedControlSnapshot> {
    const current = this.snapshots.get(scope);
    if (!current?.paused) {
      return (
        current ?? {
          scope,
          paused: false,
          reason: null,
          changedAt: now,
          onChainStatus: this.publisher ? 'unconfirmed' : 'unavailable',
        }
      );
    }

    if (!this.publisher) {
      throw new Error('Cannot resume feed without an on-chain pause publisher');
    }

    const published = await this.publisher.publishPause(
      scope,
      false,
      'operator resume',
    );
    if (!published.confirmed) {
      throw new Error('On-chain feed resume was not confirmed');
    }

    const resumed: FeedControlSnapshot = {
      scope,
      paused: false,
      reason: null,
      changedAt: now,
      onChainStatus: 'confirmed',
      txHash: published.txHash,
    };
    this.snapshots.set(scope, resumed);
    return { ...resumed };
  }

  getSnapshot(scope: FeedControlScope): FeedControlSnapshot {
    return (
      { ...(this.snapshots.get(scope) ?? {
        scope,
        paused: false,
        reason: null,
        changedAt: 0,
        onChainStatus: this.publisher ? 'unconfirmed' : 'unavailable',
      }) }
    );
  }
}
