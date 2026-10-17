export interface ShutdownResult {
  exitCode: number;
  abandonedTaskIds: string[];
  forcedByRepeatSignal: boolean;
  teardownSteps: string[];
}

export class GracefulShutdownDrainer {
  private readonly drainDeadlineMs: number;
  private readonly releaseLeaderLock: () => Promise<void>;
  private readonly closeConnectionPools: () => Promise<void>;

  private draining = false;
  private signalCount = 0;
  private readonly inFlightTasks = new Map<string, Promise<unknown>>();
  private readonly teardownSteps: string[] = [];

  constructor(options: {
    drainDeadlineMs?: number;
    releaseLeaderLock: () => Promise<void>;
    closeConnectionPools: () => Promise<void>;
  }) {
    this.drainDeadlineMs = options.drainDeadlineMs ?? 10_000;
    this.releaseLeaderLock = options.releaseLeaderLock;
    this.closeConnectionPools = options.closeConnectionPools;
  }

  public isDraining(): boolean {
    return this.draining;
  }

  public getInFlightTaskIds(): string[] {
    return Array.from(this.inFlightTasks.keys());
  }

  /**
   * Registers an in-flight publication or evidence write task.
   * Rejects new tasks once draining has started.
   */
  public async runInFlightWork<T>(
    taskId: string,
    workFn: () => Promise<T>
  ): Promise<T> {
    if (this.draining) {
      throw new Error(
        `SERVICE_DRAINING: Rejecting new oracle task '${taskId}' during graceful shutdown`
      );
    }

    const promise = (async () => {
      try {
        return await workFn();
      } finally {
        this.inFlightTasks.delete(taskId);
      }
    })();

    this.inFlightTasks.set(taskId, promise);
    return promise;
  }

  /**
   * Handles SIGTERM/SIGINT: stops new work, awaits in-flight tasks up to `drainDeadlineMs`,
   * then releases the leader lock and closes Postgres/Redis connection pools in strict order.
   */
  public async handleSignal(
    _signal: "SIGTERM" | "SIGINT" = "SIGTERM"
  ): Promise<ShutdownResult> {
    this.signalCount += 1;

    if (this.signalCount > 1) {
      const abandonedTaskIds = this.getInFlightTaskIds();
      this.teardownSteps.push("forced_immediate_exit");
      return {
        exitCode: 130,
        abandonedTaskIds,
        forcedByRepeatSignal: true,
        teardownSteps: [...this.teardownSteps],
      };
    }

    this.draining = true;
    this.teardownSteps.push("stop_new_polling");

    const pendingPromises = Array.from(this.inFlightTasks.values());
    let timedOut = false;

    if (pendingPromises.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<"TIMEOUT">((resolve) => {
        timer = setTimeout(() => resolve("TIMEOUT"), this.drainDeadlineMs);
      });

      const winner = await Promise.race([
        Promise.allSettled(pendingPromises).then(() => "DRAINED" as const),
        timeoutPromise,
      ]);

      if (timer) {
        clearTimeout(timer);
      }

      if (winner === "TIMEOUT") {
        timedOut = true;
      }
    }

    const abandonedTaskIds = this.getInFlightTaskIds();
    this.teardownSteps.push(
      timedOut ? "drain_deadline_exceeded" : "inflight_work_drained"
    );

    await this.releaseLeaderLock();
    this.teardownSteps.push("release_leader_lock");

    await this.closeConnectionPools();
    this.teardownSteps.push("close_connection_pools");

    return {
      exitCode: timedOut || abandonedTaskIds.length > 0 ? 1 : 0,
      abandonedTaskIds,
      forcedByRepeatSignal: false,
      teardownSteps: [...this.teardownSteps],
    };
  }
}
