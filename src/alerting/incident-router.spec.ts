import test from "node:test";
import assert from "node:assert/strict";
import {
  OracleIncidentRouter,
  InMemoryIncidentStore,
  computeAlertFingerprint,
  type IncidentNotification,
} from "./incident-router.ts";

test("Issue #289: computeAlertFingerprint ignores volatile fields and deduplicates flapping alerts within the dedup window", async () => {
  const notifications: IncidentNotification[] = [];
  const store = new InMemoryIncidentStore();
  const router = new OracleIncidentRouter({
    store,
    notifier: { notify: (n) => { notifications.push(n); } },
    config: {
      dedupWindowMs: 60_000,
      renotifyIntervalMs: 120_000,
      escalateAfterMs: 300_000,
    },
  });

  const fp1 = computeAlertFingerprint({
    feedId: "StablecoinDepeg",
    alertClass: "payout_divergence",
    source: "coingecko",
  });
  const fp2 = computeAlertFingerprint({
    feedId: " stablecoindepeg ",
    alertClass: "payout_divergence",
    source: "CoinGecko",
  });
  assert.equal(fp1, fp2);

  // First alert creates incident and pages primary on-call
  const first = await router.ingestAlert({
    feedId: "StablecoinDepeg",
    alertClass: "payout_divergence",
    source: "coingecko",
    payoutTriggering: true,
    message: "Divergence 4.2%",
    timestampMs: 1_000,
    volatileContext: { observedValue: 0.958, requestId: "req-1" },
  });
  assert.equal(first.deduplicated, false);
  assert.equal(first.notified, true);
  assert.equal(first.incident.channel, "page_primary");
  assert.equal(notifications.length, 1);

  // Second identical alert 10s later with different volatile value is deduplicated
  const second = await router.ingestAlert({
    feedId: "StablecoinDepeg",
    alertClass: "payout_divergence",
    source: "coingecko",
    payoutTriggering: true,
    message: "Divergence 4.5%",
    timestampMs: 11_000,
    volatileContext: { observedValue: 0.955, requestId: "req-2" },
  });
  assert.equal(second.deduplicated, true);
  assert.equal(second.notified, false);
  assert.equal(second.incident.occurrenceCount, 2);
  assert.equal(notifications.length, 1);
});

test("Issue #289: escalation timer promotes unacknowledged primary pages to secondary on-call, while acknowledgement suppresses escalation", async () => {
  const notifications: IncidentNotification[] = [];
  const store = new InMemoryIncidentStore();
  const router = new OracleIncidentRouter({
    store,
    notifier: { notify: (n) => { notifications.push(n); } },
    config: {
      dedupWindowMs: 60_000,
      renotifyIntervalMs: 100_000,
      escalateAfterMs: 300_000,
    },
  });

  const opened = await router.ingestAlert({
    feedId: "MarketCrash",
    alertClass: "payout_divergence",
    source: "coingecko",
    payoutTriggering: true,
    message: "Payout divergence detected",
    timestampMs: 10_000,
  });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].channel, "page_primary");

  // Tick at 150_000ms -> re-notifies primary on-call (since 140_000 >= 100_000 renotifyIntervalMs)
  await router.tick(150_000);
  assert.equal(notifications.length, 2);
  assert.equal(notifications[1].reason, "renotify");
  assert.equal(notifications[1].channel, "page_primary");

  // Tick at 315_000ms -> escalates to page_secondary (since 305_000 >= 300_000 escalateAfterMs)
  await router.tick(315_000);
  assert.equal(notifications.length, 3);
  assert.equal(notifications[2].reason, "escalate");
  assert.equal(notifications[2].channel, "page_secondary");

  // Operator acknowledges the incident; subsequent ticks do not re-page
  const acked = await router.acknowledge(opened.incident.incidentId, "oncall-alice", 320_000);
  assert.equal(acked?.state, "acknowledged");
  await router.tick(600_000);
  assert.equal(notifications.length, 3);

  // Auto-resolve when underlying condition clears
  const resolved = await router.resolveByGroupKey(
    opened.incident.groupKey,
    "Divergence cleared across 3 consecutive windows",
    650_000
  );
  assert.equal(resolved?.state, "resolved");
  assert.equal(notifications.length, 4);
  assert.equal(notifications[3].reason, "resolved");
  assert.ok(resolved?.timeline.some((e) => e.event === "resolved"));
});

test("Issue #289: alert storm from a single provider outage across N feeds groups into 1 incident with bounded notifications and survives router restart", async () => {
  const notifications: IncidentNotification[] = [];
  const sharedStore = new InMemoryIncidentStore();
  const router1 = new OracleIncidentRouter({
    store: sharedStore,
    notifier: { notify: (n) => { notifications.push(n); } },
    config: { dedupWindowMs: 60_000 },
  });

  const feeds = [
    "StablecoinDepeg",
    "MarketCrash",
    "SmartContractRisk",
    "LiquidationShield",
    "FlightDelay",
  ];

  // Emit 50 alerts across 5 feeds for a single provider outage ("coingecko")
  for (let round = 0; round < 10; round++) {
    for (const feedId of feeds) {
      await router1.ingestAlert({
        feedId,
        alertClass: "provider_outage",
        source: "coingecko",
        payoutTriggering: false,
        message: `CoinGecko HTTP 503 for ${feedId}`,
        timestampMs: 1_000 + round * 1_000,
      });
    }
  }

  // All 50 alerts grouped into a single ticket incident with exactly 1 initial notification
  const openList = await sharedStore.listOpen();
  assert.equal(openList.length, 1);
  assert.equal(openList[0].affectedFeeds.length, 5);
  assert.equal(openList[0].occurrenceCount, 50);
  assert.equal(openList[0].channel, "ticket");
  assert.equal(notifications.length, 1);

  // Simulate process restart with a new router instance backed by the same store
  const routerAfterRestart = new OracleIncidentRouter({
    store: sharedStore,
    notifier: { notify: (n) => { notifications.push(n); } },
    config: { dedupWindowMs: 60_000 },
  });
  const postRestart = await routerAfterRestart.ingestAlert({
    feedId: "StablecoinDepeg",
    alertClass: "provider_outage",
    source: "coingecko",
    payoutTriggering: false,
    message: "Still down",
    timestampMs: 15_000,
  });
  assert.equal(postRestart.deduplicated, true);
  assert.equal(notifications.length, 1, "Restart must not re-page an already open incident");
});
