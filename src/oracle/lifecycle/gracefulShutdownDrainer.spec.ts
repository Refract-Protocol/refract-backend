import { test } from "node:test";
import assert from "node:assert/strict";
import { GracefulShutdownDrainer } from "./gracefulShutdownDrainer.ts";

test("GracefulShutdownDrainer drains in-flight publication and evidence writes before releasing leader lock and closing pools", async () => {
  const events: string[] = [];
  let completePublish!: () => void;

  const drainer = new GracefulShutdownDrainer({
    drainDeadlineMs: 2_000,
    releaseLeaderLock: async () => {
      events.push("leader_lock_released");
    },
    closeConnectionPools: async () => {
      events.push("pools_closed");
    },
  });

  // Start an in-flight publish + evidence write
  const publishPromise = drainer.runInFlightWork("pub-round-42", async () => {
    await new Promise<void>((resolve) => {
      completePublish = resolve;
    });
    events.push("onchain_publish_and_evidence_completed");
    return "tx-42";
  });

  // Send SIGTERM while publish is in-flight
  const shutdownPromise = drainer.handleSignal("SIGTERM");
  assert.equal(drainer.isDraining(), true);

  // Reject any new poll/claim task while draining
  await assert.rejects(
    () => drainer.runInFlightWork("new-poll", async () => "nope"),
    /SERVICE_DRAINING/
  );

  // Finish the in-flight publish
  completePublish();
  await publishPromise;

  const result = await shutdownPromise;
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.abandonedTaskIds, []);
  assert.deepEqual(events, [
    "onchain_publish_and_evidence_completed",
    "leader_lock_released",
    "pools_closed",
  ]);
  assert.deepEqual(result.teardownSteps, [
    "stop_new_polling",
    "inflight_work_drained",
    "release_leader_lock",
    "close_connection_pools",
  ]);
});

test("GracefulShutdownDrainer exits non-zero with abandoned task IDs when drain deadline expires", async () => {
  let unblockHungTask!: () => void;
  const drainer = new GracefulShutdownDrainer({
    drainDeadlineMs: 25,
    releaseLeaderLock: async () => {},
    closeConnectionPools: async () => {},
  });

  const hungTask = drainer.runInFlightWork("hung-publish-99", () => {
    return new Promise<void>((resolve) => {
      unblockHungTask = resolve;
    });
  });

  const result = await drainer.handleSignal("SIGTERM");
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.abandonedTaskIds, ["hung-publish-99"]);

  unblockHungTask();
  await hungTask;
});
