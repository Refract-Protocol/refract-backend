import { InFlightTracker } from "./in-flight-tracker";
import { LocalLeaderLock, RedisLeaderLock, RedisLockClient } from "./leader-lock";
import { loadOracleShutdownOptions, OraclePipelineLifecycle } from "./oracle-pipeline-lifecycle.service";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Minimal in-memory Redis with the lock scripts' semantics. */
function fakeRedis() {
  const store = new Map<string, string>();
  const client: RedisLockClient & { store: Map<string, string> } = {
    store,
    async set(key, value) {
      if (store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async eval(script, _n, key, token) {
      if (store.get(String(key)) !== token) return 0;
      if (script.includes("del")) store.delete(String(key));
      return 1;
    },
    quit: jest.fn(async () => "OK"),
  };
  return client;
}

describe("InFlightTracker", () => {
  it("drains immediately when idle", async () => {
    const result = await new InFlightTracker().drain(1_000);
    expect(result).toMatchObject({ drained: true, pending: {} });
  });

  it("waits for work started during the drain (poll → evidence)", async () => {
    const tracker = new InFlightTracker();
    const poll = deferred();
    const evidence = deferred();
    tracker.track("poll", async () => {
      await poll.promise;
      void tracker.track("evidence", () => evidence.promise);
    });

    const draining = tracker.drain(1_000);
    poll.resolve();
    await new Promise((r) => setImmediate(r));
    expect(tracker.count("evidence")).toBe(1);
    evidence.resolve();
    await expect(draining).resolves.toMatchObject({ drained: true });
  });

  it("reports abandoned work when the deadline passes", async () => {
    const tracker = new InFlightTracker();
    void tracker.track("publish", () => new Promise(() => undefined));
    void tracker.track("evidence", () => new Promise(() => undefined), "oracle_event:MarketCrash");
    const result = await tracker.drain(20);
    expect(result).toMatchObject({ drained: false, pending: { publish: 1, evidence: 1 } });
    expect(result.abandoned.map((a) => a.id)).toContain("oracle_event:MarketCrash");
  });

  it("does not count failed work as pending", async () => {
    const tracker = new InFlightTracker();
    await expect(tracker.track("publish", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(tracker.count()).toBe(0);
  });
});

describe("RedisLeaderLock", () => {
  it("acquires, renews, and lets one holder at a time lead", async () => {
    const redis = fakeRedis();
    const a = new RedisLeaderLock(redis, "k", 1_000, "a");
    const b = new RedisLeaderLock(redis, "k", 1_000, "b");
    expect(await a.acquire()).toBe(true);
    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(false);
    await a.release();
    expect(redis.store.has("k")).toBe(false);
    expect(await b.acquire()).toBe(true);
  });

  it("never deletes a lock another replica took over", async () => {
    const redis = fakeRedis();
    const a = new RedisLeaderLock(redis, "k", 1_000, "a");
    await a.acquire();
    redis.store.set("k", "b"); // a's TTL ran out and b took the lock
    await a.release();
    expect(redis.store.get("k")).toBe("b");
  });
});

describe("loadOracleShutdownOptions", () => {
  it("keeps the drain below the process grace period", () => {
    expect(loadOracleShutdownOptions({}).drainDeadlineMs).toBe(20_000);
    expect(
      loadOracleShutdownOptions({ ORACLE_SHUTDOWN_DRAIN_MS: "60000", SHUTDOWN_GRACE_PERIOD_MS: "30000" })
        .drainDeadlineMs,
    ).toBe(25_000);
    expect(loadOracleShutdownOptions({ ORACLE_SHUTDOWN_DRAIN_MS: "nope" }).drainDeadlineMs).toBe(20_000);
  });
});

describe("OraclePipelineLifecycle", () => {
  it("stops new polls once shutdown begins but finishes the running one", async () => {
    const lock = new LocalLeaderLock();
    const lifecycle = new OraclePipelineLifecycle(lock, { drainDeadlineMs: 1_000 });
    const publish = deferred();
    const evidenceWritten = jest.fn();

    const running = lifecycle.runPoll(async () => {
      await lifecycle.track("publish", () => publish.promise);
      await lifecycle.track("evidence", async () => evidenceWritten());
    });
    await new Promise((r) => setImmediate(r));

    lifecycle.onModuleDestroy();
    const second = jest.fn(async () => undefined);
    expect(await lifecycle.runPoll(second)).toBe(false);
    expect(second).not.toHaveBeenCalled();

    const shutdown = lifecycle.beforeApplicationShutdown("SIGTERM");
    publish.resolve();
    await shutdown;
    await running;

    expect(evidenceWritten).toHaveBeenCalled();
    expect(lifecycle.lastDrainResult()).toMatchObject({ drained: true });
    expect(lock.isHeld()).toBe(false);
  });

  it("skips polls when another replica leads", async () => {
    const redis = fakeRedis();
    redis.store.set("k", "other");
    const lifecycle = new OraclePipelineLifecycle(new RedisLeaderLock(redis, "k", 1_000, "me"), {
      drainDeadlineMs: 100,
    });
    const work = jest.fn(async () => undefined);
    expect(await lifecycle.runPoll(work)).toBe(false);
    expect(work).not.toHaveBeenCalled();
  });

  it("releases and closes the lock even when the drain times out", async () => {
    const redis = fakeRedis();
    const lock = new RedisLeaderLock(redis, "k", 1_000, "me");
    const lifecycle = new OraclePipelineLifecycle(lock, { drainDeadlineMs: 20 });
    void lifecycle.runPoll(() => new Promise(() => undefined));
    await new Promise((r) => setImmediate(r));

    await lifecycle.beforeApplicationShutdown("SIGTERM");
    expect(lifecycle.lastDrainResult()).toMatchObject({ drained: false, pending: { poll: 1 } });
    expect(lifecycle.lastDrainResult()?.abandoned[0].id).toMatch(/^poll@/);
    expect(redis.store.has("k")).toBe(false);
    expect(redis.quit).toHaveBeenCalled();
  });
});
