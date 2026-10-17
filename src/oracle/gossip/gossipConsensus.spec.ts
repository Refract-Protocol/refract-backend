import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GossipConsensusNode,
  deriveDeterministicRoundConsensus,
} from "./gossipConsensus.ts";

test("Issue #275: 5-node simulation with 1 Byzantine equivocating peer converges on identical decisionHash and quarantines equivocator", () => {
  const now = 1_750_000_000_000;
  const nodeIds = ["op_1", "op_2", "op_3", "op_4", "op_byzantine"];
  const nodes = new Map<string, GossipConsensusNode>();

  for (const id of nodeIds) {
    const node = new GossipConsensusNode({
      operatorId: id,
      minDistinctOperators: 3,
      maxFanOut: 3,
      defaultTtlHops: 3,
    });
    for (const peerId of nodeIds) {
      node.registerPeer(peerId);
    }
    nodes.set(id, node);
  }

  // Honest announcements from op_1..op_4
  const a1 = nodes.get("op_1")!.createLocalAnnouncement(
    {
      feedId: "StablecoinDepeg",
      roundNumber: 77,
      valueScaled: 100n,
      observedAtMs: now - 1_000,
      sourceIds: ["coingecko", "defillama"],
    },
    now
  ).envelope;

  const a2 = nodes.get("op_2")!.createLocalAnnouncement(
    {
      feedId: "StablecoinDepeg",
      roundNumber: 77,
      valueScaled: 110n,
      observedAtMs: now - 1_000,
      sourceIds: ["coingecko", "horizon"],
    },
    now
  ).envelope;

  const a3 = nodes.get("op_3")!.createLocalAnnouncement(
    {
      feedId: "StablecoinDepeg",
      roundNumber: 77,
      valueScaled: 120n,
      observedAtMs: now - 1_000,
      sourceIds: ["defillama", "horizon"],
    },
    now
  ).envelope;

  const a4 = nodes.get("op_4")!.createLocalAnnouncement(
    {
      feedId: "StablecoinDepeg",
      roundNumber: 77,
      valueScaled: 130n,
      observedAtMs: now - 1_000,
      sourceIds: ["coingecko", "defillama", "horizon"],
    },
    now
  ).envelope;

  // Byzantine peer sends two conflicting announcements for round 77!
  const byzA = nodes.get("op_byzantine")!.createLocalAnnouncement(
    {
      feedId: "StablecoinDepeg",
      roundNumber: 77,
      valueScaled: 9_999n,
      observedAtMs: now - 1_000,
      sourceIds: ["coingecko"],
    },
    now
  ).envelope;

  const byzB = nodes.get("op_byzantine")!.createLocalAnnouncement(
    {
      feedId: "StablecoinDepeg",
      roundNumber: 77,
      valueScaled: 1n,
      observedAtMs: now - 500,
      sourceIds: ["coingecko"],
    },
    now
  ).envelope;

  const allEnvelopes = [a1, a2, a3, a4, byzA, byzB];

  // Deliver to op_1 in forward order and to op_2 in reverse order
  for (const env of allEnvelopes) {
    nodes.get("op_1")!.receiveAnnouncement(env, now);
  }
  for (const env of [...allEnvelopes].reverse()) {
    nodes.get("op_2")!.receiveAnnouncement(env, now);
  }

  const out1 = nodes.get("op_1")!.evaluateRound("StablecoinDepeg", 77, now);
  const out2 = nodes.get("op_2")!.evaluateRound("StablecoinDepeg", 77, now);

  assert.equal(out1.committed, true);
  assert.equal(out2.committed, true);
  assert.deepEqual(out1.equivocatingOperators, ["op_byzantine"]);
  assert.deepEqual(out1.contributingOperators, ["op_1", "op_2", "op_3", "op_4"]);
  // Median of [100n, 110n, 120n, 130n] = (110n + 120n) / 2n = 115n
  assert.equal(out1.consensusValueScaled, 115n);
  assert.equal(out1.decisionHash, out2.decisionHash);
  assert.deepEqual(out1.contributingReadingHashes, out2.contributingReadingHashes);
});

test("Issue #275: fails closed under network partition (< minDistinctOperators) and enforces deduplication, clock skew, and rate limits", () => {
  const now = 1_750_000_000_000;
  const isolatedNode = new GossipConsensusNode({
    operatorId: "op_isolated",
    minDistinctOperators: 3,
    maxClockSkewMs: 10_000,
    maxMessagesPerPeerWindow: 2,
    rateLimitWindowMs: 60_000,
  });

  const localAnn = isolatedNode.createLocalAnnouncement(
    {
      feedId: "MarketCrash",
      roundNumber: 1,
      valueScaled: 500n,
      observedAtMs: now,
      sourceIds: ["coingecko"],
    },
    now
  ).envelope;

  // Partitioned single node has only 1 operator (< 3) -> MUST fail closed
  const partitionOutcome = isolatedNode.evaluateRound("MarketCrash", 1, now);
  assert.equal(partitionOutcome.committed, false);
  assert.equal(partitionOutcome.failClosedReason, "insufficient_operator_quorum");

  // Duplicate receipt is rejected
  const dupRes = isolatedNode.receiveAnnouncement(localAnn, now);
  assert.equal(dupRes.accepted, false);
  assert.equal(dupRes.reason, "duplicate");

  // Clock-skewed peer message is rejected
  const peerNode = new GossipConsensusNode({ operatorId: "op_peer" });
  const skewedEnv = peerNode.createLocalAnnouncement(
    {
      feedId: "MarketCrash",
      roundNumber: 1,
      valueScaled: 500n,
      observedAtMs: now - 60_000,
      sourceIds: ["coingecko"],
    },
    now - 60_000
  ).envelope;

  const skewRes = isolatedNode.receiveAnnouncement(skewedEnv, now);
  assert.equal(skewRes.accepted, false);
  assert.equal(skewRes.reason, "clock_skew_exceeded");

  // Third message from op_peer within window is rate-limited (maxMessagesPerPeerWindow = 2)
  const validPeerEnv = peerNode.createLocalAnnouncement(
    {
      feedId: "MarketCrash",
      roundNumber: 2,
      valueScaled: 510n,
      observedAtMs: now,
      sourceIds: ["coingecko"],
    },
    now
  ).envelope;
  assert.equal(isolatedNode.receiveAnnouncement(validPeerEnv, now).accepted, true);

  const thirdPeerEnv = peerNode.createLocalAnnouncement(
    {
      feedId: "MarketCrash",
      roundNumber: 3,
      valueScaled: 520n,
      observedAtMs: now,
      sourceIds: ["coingecko"],
    },
    now
  ).envelope;
  const rateLimited = isolatedNode.receiveAnnouncement(thirdPeerEnv, now);
  assert.equal(rateLimited.accepted, false);
  assert.equal(rateLimited.reason, "rate_limited");

  // Pure replay check
  const replay = deriveDeterministicRoundConsensus(
    "MarketCrash",
    1,
    [localAnn],
    3,
    "op_isolated",
    now
  );
  assert.equal(replay.committed, false);
});
