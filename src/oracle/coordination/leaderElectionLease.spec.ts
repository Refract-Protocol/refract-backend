import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryRedisLeaseStore,
  OracleLeaderElector,
  FencedSingleFlightPublisherGuard,
} from "./leaderElectionLease.ts";

describe("Redis-Based Leader Election and Single-Flight Locking (#205)", () => {
  it("prevents concurrent replicas from acquiring leadership simultaneously and rejects stale fencing tokens after lease expiry", async () => {
    const store = new InMemoryRedisLeaseStore();
    const replicaA = new OracleLeaderElector({
      store,
      instanceId: "replica-a",
      leaseTtlMs: 10_000,
    });
    const replicaB = new OracleLeaderElector({
      store,
      instanceId: "replica-b",
      leaseTtlMs: 10_000,
    });
    const publisherGuard = new FencedSingleFlightPublisherGuard();

    const nowMs = 1_700_000_000_000;
    assert.equal(await replicaA.acquire(nowMs), true);
    assert.equal(await replicaB.acquire(nowMs + 1_000), false);

    const tokenA1 = replicaA.getFencingToken(nowMs + 1_000);
    assert.equal(tokenA1, 1);
    publisherGuard.validateAndAdvanceFencingToken(tokenA1);

    // Replica A stalls past lease expiry (nowMs + 12_000); Replica B acquires lease with monotonic fencingToken = 2
    assert.equal(await replicaB.acquire(nowMs + 12_000), true);
    const tokenB2 = replicaB.getFencingToken(nowMs + 12_000);
    assert.equal(tokenB2, 2);
    publisherGuard.validateAndAdvanceFencingToken(tokenB2);

    // If stalled Replica A wakes up and attempts to publish with old token 1, the fencing guard rejects it
    assert.throws(
      () => publisherGuard.validateAndAdvanceFencingToken(tokenA1),
      /STALE_FENCING_TOKEN_REJECTED/
    );
  });

  it("steps down fail-safely when Redis becomes unreachable and supports graceful handoff on release", async () => {
    const store = new InMemoryRedisLeaseStore();
    const replicaA = new OracleLeaderElector({
      store,
      instanceId: "replica-a",
      leaseTtlMs: 10_000,
    });
    const replicaB = new OracleLeaderElector({
      store,
      instanceId: "replica-b",
      leaseTtlMs: 10_000,
    });

    const nowMs = 1_700_000_000_000;
    assert.equal(await replicaA.acquire(nowMs), true);
    assert.equal(replicaA.getHealthSnapshot(nowMs).leaderGaugeMetric, 1);

    // Simulate Redis outage during renew -> replicaA immediately steps down
    store.setReachable(false);
    assert.equal(await replicaA.renew(nowMs + 3_000), false);
    assert.equal(replicaA.isLeader(nowMs + 3_000), false);
    assert.equal(
      replicaA.getHealthSnapshot(nowMs + 3_000).lastError,
      "REDIS_UNREACHABLE"
    );

    // Restore Redis and verify graceful release + handoff
    store.setReachable(true);
    assert.equal(await replicaA.acquire(nowMs + 15_000), true);
    assert.equal(await replicaA.release(), true);
    assert.equal(await replicaB.acquire(nowMs + 15_100), true);
    assert.equal(replicaB.isLeader(nowMs + 15_100), true);
  });
});
