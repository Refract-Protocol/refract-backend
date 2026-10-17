export interface PublishedFeedSnapshot {
  feedId: string;
  canonicalValue: number;
  decidedAtMs: number;
  correlationId: string;
}

export interface WorkerHeartbeatRecord {
  workerId: string;
  fencingToken: number;
  lastCompletedCycleAtMs: number;
  lastCorrelationId: string;
  settledClaimsInCycle: number;
}

export class SharedPipelineStateStore {
  private heartbeat: WorkerHeartbeatRecord | null = null;
  private readonly latestFeeds = new Map<string, PublishedFeedSnapshot>();

  public writeWorkerCycleState(params: {
    heartbeat: WorkerHeartbeatRecord;
    publishedFeeds: PublishedFeedSnapshot[];
  }): void {
    if (
      this.heartbeat &&
      params.heartbeat.fencingToken < this.heartbeat.fencingToken
    ) {
      throw new Error("STALE_WORKER_FENCING_TOKEN");
    }
    this.heartbeat = { ...params.heartbeat };
    for (const feed of params.publishedFeeds) {
      this.latestFeeds.set(feed.feedId, { ...feed });
    }
  }

  public readHeartbeat(): WorkerHeartbeatRecord | null {
    return this.heartbeat ? { ...this.heartbeat } : null;
  }

  public readFeedSnapshot(feedId: string): PublishedFeedSnapshot | null {
    const item = this.latestFeeds.get(feedId);
    return item ? { ...item } : null;
  }
}

export class OracleSettlementWorkerRuntime {
  public readonly workerId: string;
  private readonly store: SharedPipelineStateStore;
  private readonly fencingToken: number;
  private readonly runPollAndSettleCycle: (
    correlationId: string,
    nowMs: number
  ) => Promise<{
    publishedFeeds: PublishedFeedSnapshot[];
    settledClaimsCount: number;
  }>;
  private running = false;
  private cycleCounter = 0;

  constructor(options: {
    workerId: string;
    fencingToken: number;
    store: SharedPipelineStateStore;
    runPollAndSettleCycle: (
      correlationId: string,
      nowMs: number
    ) => Promise<{
      publishedFeeds: PublishedFeedSnapshot[];
      settledClaimsCount: number;
    }>;
  }) {
    this.workerId = options.workerId;
    this.fencingToken = options.fencingToken;
    this.store = options.store;
    this.runPollAndSettleCycle = options.runPollAndSettleCycle;
  }

  public start(): void {
    this.running = true;
  }

  public stop(): void {
    this.running = false;
  }

  public isRunning(): boolean {
    return this.running;
  }

  public async executeTick(nowMs: number = Date.now()): Promise<{
    executed: boolean;
    correlationId: string | null;
  }> {
    if (!this.running) {
      return { executed: false, correlationId: null };
    }

    this.cycleCounter += 1;
    const correlationId = `${this.workerId}-cycle-${this.cycleCounter}`;
    const cycleResult = await this.runPollAndSettleCycle(correlationId, nowMs);

    this.store.writeWorkerCycleState({
      heartbeat: {
        workerId: this.workerId,
        fencingToken: this.fencingToken,
        lastCompletedCycleAtMs: nowMs,
        lastCorrelationId: correlationId,
        settledClaimsInCycle: cycleResult.settledClaimsCount,
      },
      publishedFeeds: cycleResult.publishedFeeds,
    });

    return { executed: true, correlationId };
  }
}

export class ApiProcessPipelineReader {
  private readonly store: SharedPipelineStateStore;
  private readonly maxWorkerHeartbeatAgeMs: number;

  constructor(options: {
    store: SharedPipelineStateStore;
    maxWorkerHeartbeatAgeMs?: number;
  }) {
    this.store = options.store;
    this.maxWorkerHeartbeatAgeMs = options.maxWorkerHeartbeatAgeMs ?? 30_000;
  }

  public getApiPipelineStatus(
    feedId: string,
    nowMs: number = Date.now()
  ): {
    status: "healthy" | "degraded_worker_offline";
    workerHeartbeatAgeMs: number | null;
    lastCorrelationId: string | null;
    feed: PublishedFeedSnapshot | null;
    freshForQuoting: boolean;
  } {
    const hb = this.store.readHeartbeat();
    const feed = this.store.readFeedSnapshot(feedId);

    if (!hb) {
      return {
        status: "degraded_worker_offline",
        workerHeartbeatAgeMs: null,
        lastCorrelationId: null,
        feed,
        freshForQuoting: false,
      };
    }

    const ageMs = Math.max(0, nowMs - hb.lastCompletedCycleAtMs);
    const workerHealthy = ageMs <= this.maxWorkerHeartbeatAgeMs;

    return {
      status: workerHealthy ? "healthy" : "degraded_worker_offline",
      workerHeartbeatAgeMs: ageMs,
      lastCorrelationId: hb.lastCorrelationId,
      feed,
      freshForQuoting: workerHealthy && feed !== null,
    };
  }
}
