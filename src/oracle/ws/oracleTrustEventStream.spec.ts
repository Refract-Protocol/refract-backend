import { test } from "node:test";
import assert from "node:assert/strict";
import { OracleTrustEventStreamHub } from "./oracleTrustEventStream.ts";

test("OracleTrustEventStreamHub sends connect snapshot, redacts internal fields for public clients, and suppresses duplicates", () => {
  const hub = new OracleTrustEventStreamHub({ maxBufferSizePerClient: 3 });

  hub.updateFeedSnapshot("USDC-DEPEG", {
    status: "corroborated",
    healthySources: 4,
    operatorEmail: "oncall@refract.finance",
    apiKey: "secret-key",
  });

  // Unauthenticated public client receives redacted snapshot on connect
  const initialPublic = hub.connectAndSubscribe({
    clientId: "public-1",
    authenticated: false,
    feeds: ["USDC-DEPEG"],
    channels: ["trust.pause", "trust.source"],
    nowMs: 1_000,
  });
  assert.equal(initialPublic.length, 1);
  assert.equal(initialPublic[0].channel, "trust.snapshot");
  assert.equal(initialPublic[0].payload.status, "corroborated");
  assert.equal("operatorEmail" in initialPublic[0].payload, false);
  assert.equal("apiKey" in initialPublic[0].payload, false);

  // Authenticated ops client receives operatorEmail but never apiKey
  const initialOps = hub.connectAndSubscribe({
    clientId: "ops-1",
    authenticated: true,
    feeds: ["USDC-DEPEG"],
    channels: ["trust.pause"],
    nowMs: 1_000,
  });
  assert.equal(
    initialOps[0].payload.operatorEmail,
    "oncall@refract.finance"
  );
  assert.equal("apiKey" in initialOps[0].payload, false);

  // Publish pause event -> delivered once, duplicate eventId suppressed
  const pub1 = hub.publishEvent({
    eventId: "evt-pause-1",
    channel: "trust.pause",
    feedId: "USDC-DEPEG",
    timestampMs: 2_000,
    payload: { paused: true, operatorEmail: "oncall@refract.finance" },
  });
  assert.equal(pub1.deliveredClients, 2);
  assert.equal(pub1.deduplicated, false);

  const pubDup = hub.publishEvent({
    eventId: "evt-pause-1",
    channel: "trust.pause",
    feedId: "USDC-DEPEG",
    timestampMs: 2_000,
    payload: { paused: true },
  });
  assert.equal(pubDup.deduplicated, true);
});

test("OracleTrustEventStreamHub bounds slow-consumer buffer with drop-oldest and resyncRequired signal", () => {
  const hub = new OracleTrustEventStreamHub({ maxBufferSizePerClient: 2 });

  // Connect puts 1 snapshot message in buffer
  hub.connectAndSubscribe({
    clientId: "slow-client",
    authenticated: false,
    feeds: ["XLM-USD"],
    channels: ["trust.source"],
    nowMs: 1_000,
  });

  // 2nd message fills buffer (size=2)
  hub.publishEvent({
    eventId: "evt-1",
    channel: "trust.source",
    feedId: "XLM-USD",
    timestampMs: 2_000,
    payload: { quarantined: "coingecko" },
  });

  // 3rd message overflows buffer -> drops oldest and marks resyncRequired=true
  hub.publishEvent({
    eventId: "evt-2",
    channel: "trust.source",
    feedId: "XLM-USD",
    timestampMs: 3_000,
    payload: { quarantined: "horizon" },
  });

  const drained = hub.drainClientBuffer("slow-client");
  assert.equal(drained.length, 2);
  assert.equal(drained[0].eventId, "evt-1");
  assert.equal(drained[1].eventId, "evt-2");
  assert.equal(drained[1].resyncRequired, true);
});
