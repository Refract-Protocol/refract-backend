import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DeadMansSwitchWatchdog,
  type DeadMansSwitchHeartbeatPayload,
} from "./deadMansSwitchWatchdog.ts";

test("DeadMansSwitchWatchdog emits heartbeat only on completed poll+DB cycle and tolerates transient receiver failures", async () => {
  const sentPayloads: DeadMansSwitchHeartbeatPayload[] = [];
  let shouldFailReceiver = false;

  const watchdog = new DeadMansSwitchWatchdog({
    maxCycleSilenceMs: 30_000,
    maxMetricsScrapeSilenceMs: 60_000,
    maxConsecutiveReceiverMisses: 3,
    sendExternalHeartbeat: async (payload) => {
      if (shouldFailReceiver) {
        throw new Error("502 Bad Gateway");
      }
      sentPayloads.push(payload);
    },
  });

  // Incomplete DB write suppresses heartbeat
  const suppressed = await watchdog.onWorkCycleFinished({
    pollCycleSucceeded: true,
    dbWriteSucceeded: false,
    healthyFeedCount: 5,
    totalFeedCount: 5,
    lastSuccessfulPublishAtMs: 1_000,
    nowMs: 1_000,
  });
  assert.equal(suppressed.heartbeatSent, false);
  assert.equal(suppressed.suppressedReason, "CYCLE_OR_DB_WRITE_INCOMPLETE");
  assert.equal(sentPayloads.length, 0);

  // Completed poll + DB write sends structured heartbeat
  const ok = await watchdog.onWorkCycleFinished({
    pollCycleSucceeded: true,
    dbWriteSucceeded: true,
    healthyFeedCount: 4,
    totalFeedCount: 5,
    lastSuccessfulPublishAtMs: 1_900,
    nowMs: 2_000,
  });
  assert.equal(ok.heartbeatSent, true);
  assert.equal(sentPayloads.length, 1);
  assert.equal(sentPayloads[0].healthyFeedCount, 4);

  // Single transient receiver failure does not trigger HEARTBEAT_RECEIVER_UNREACHABLE
  shouldFailReceiver = true;
  await watchdog.onWorkCycleFinished({
    pollCycleSucceeded: true,
    dbWriteSucceeded: true,
    healthyFeedCount: 5,
    totalFeedCount: 5,
    lastSuccessfulPublishAtMs: 2_900,
    nowMs: 3_000,
  });
  assert.equal(watchdog.getMetaAlerts().length, 0);

  // Consecutive failures reaching threshold (3) raise HEARTBEAT_RECEIVER_UNREACHABLE
  await watchdog.onWorkCycleFinished({
    pollCycleSucceeded: true,
    dbWriteSucceeded: true,
    healthyFeedCount: 5,
    totalFeedCount: 5,
    lastSuccessfulPublishAtMs: 3_900,
    nowMs: 4_000,
  });
  await watchdog.onWorkCycleFinished({
    pollCycleSucceeded: true,
    dbWriteSucceeded: true,
    healthyFeedCount: 5,
    totalFeedCount: 5,
    lastSuccessfulPublishAtMs: 4_900,
    nowMs: 5_000,
  });
  assert.equal(watchdog.getMetaAlerts().length, 1);
  assert.equal(
    watchdog.getMetaAlerts()[0].code,
    "HEARTBEAT_RECEIVER_UNREACHABLE"
  );
});

test("DeadMansSwitchWatchdog detects stalled cycles and lapsed Prometheus scrapes", async () => {
  const watchdog = new DeadMansSwitchWatchdog({
    maxCycleSilenceMs: 10_000,
    maxMetricsScrapeSilenceMs: 20_000,
    sendExternalHeartbeat: async () => {},
  });

  await watchdog.onWorkCycleFinished({
    pollCycleSucceeded: true,
    dbWriteSucceeded: true,
    healthyFeedCount: 3,
    totalFeedCount: 3,
    lastSuccessfulPublishAtMs: 1_000,
    nowMs: 1_000,
  });
  watchdog.recordMetricsScrape(1_000);

  assert.equal(watchdog.evaluateMetaWatchdog(5_000).length, 0);

  // At t=15_000, cycle silence (14s > 10s) triggers PIPELINE_CYCLE_STALLED while scrape is still fresh (14s <= 20s)
  const alertsAt15s = watchdog.evaluateMetaWatchdog(15_000);
  assert.equal(alertsAt15s.length, 1);
  assert.equal(alertsAt15s[0].code, "PIPELINE_CYCLE_STALLED");

  // At t=25_000, both cycle and metrics scrape have lapsed
  const alertsAt25s = watchdog.evaluateMetaWatchdog(25_000);
  assert.equal(alertsAt25s.length, 2);
  assert.deepEqual(
    alertsAt25s.map((a) => a.code),
    ["PIPELINE_CYCLE_STALLED", "METRICS_SCRAPE_LAPSED"]
  );
});
