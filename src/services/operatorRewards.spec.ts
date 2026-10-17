import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OperatorRewardEngine,
  type CommittedConsensusRoundInput,
} from "./operatorRewards.ts";

test("Issue #281: accrues rewards only for included_in_consensus readings, applies stake/reputation weighting and dominance cap, and is idempotent", () => {
  const engine = new OperatorRewardEngine({
    baseParticipationFloorStroops: 100_000_000n,
    maxSingleOperatorShareBps: 4_500, // 45% dominance cap
    disputeWindowMs: 3_600_000,
    minPayoutThresholdStroops: 50_000_000n,
  });

  const round: CommittedConsensusRoundInput = {
    decisionId: "dec_1001",
    feedId: "StablecoinDepeg",
    roundNumber: 42,
    committedAtMs: 1_750_000_000_000,
    roundRewardPoolStroops: 1_000_000_000n, // 100 units
    submissions: [
      {
        operatorId: "op_whale",
        readingId: "r_1",
        status: "included_in_consensus",
        stakeStroops: 9_900_000_000n,
        reputationScoreBps: 10_000,
      },
      {
        operatorId: "op_zero_stake",
        readingId: "r_2",
        status: "included_in_consensus",
        stakeStroops: 0n,
        reputationScoreBps: 8_000,
      },
      {
        operatorId: "op_late",
        readingId: "r_3",
        status: "late_after_watermark",
        stakeStroops: 5_000_000_000n,
        reputationScoreBps: 10_000,
      },
      {
        operatorId: "op_quarantined",
        readingId: "r_4",
        status: "quarantined",
        stakeStroops: 5_000_000_000n,
        reputationScoreBps: 10_000,
      },
      {
        operatorId: "op_whale",
        readingId: "r_1_dup",
        status: "included_in_consensus",
        stakeStroops: 9_900_000_000n,
        reputationScoreBps: 10_000,
      },
    ],
  };

  const firstAccrual = engine.accrueRoundRewards(round);
  assert.equal(firstAccrual.length, 2);

  const whaleEntry = firstAccrual.find((e) => e.operatorId === "op_whale")!;
  const zeroStakeEntry = firstAccrual.find((e) => e.operatorId === "op_zero_stake")!;

  // Whale would have >99% uncapped, so whale is capped at 45% = 450_000_000n
  assert.equal(whaleEntry.amountStroops, 450_000_000n);
  // Zero-stake operator still receives positive reward from baseParticipationFloorStroops
  assert.equal(zeroStakeEntry.amountStroops > 0n, true);

  // Late and quarantined operators accrue nothing
  assert.equal(
    engine.getOperatorRewardSummary("op_late", 1_750_000_000_000).totalValidAccruedStroops,
    0n
  );
  assert.equal(
    engine.getOperatorRewardSummary("op_quarantined", 1_750_000_000_000).totalValidAccruedStroops,
    0n
  );

  // Duplicate delivery of the same decisionId is idempotent
  const duplicateDelivery = engine.accrueRoundRewards(round);
  assert.equal(duplicateDelivery.length, 2);
  assert.equal(
    engine.getOperatorRewardSummary("op_whale", 1_750_000_000_000).totalValidAccruedStroops,
    450_000_000n
  );
});

test("Issue #281: enforces dispute window, minimum payout threshold, and remediation invalidation", () => {
  const startMs = 1_750_000_000_000;
  const disputeWindowMs = 60_000;
  const engine = new OperatorRewardEngine({
    baseParticipationFloorStroops: 100_000_000n,
    maxSingleOperatorShareBps: 10_000,
    disputeWindowMs,
    minPayoutThresholdStroops: 300_000_000n,
  });

  // Round 1: 200M stroops to op_1 (below 300M minPayoutThreshold)
  engine.accrueRoundRewards({
    decisionId: "dec_r1",
    feedId: "MarketCrash",
    roundNumber: 1,
    committedAtMs: startMs,
    roundRewardPoolStroops: 200_000_000n,
    submissions: [
      {
        operatorId: "op_1",
        readingId: "r1",
        status: "included_in_consensus",
        stakeStroops: 100_000_000n,
        reputationScoreBps: 10_000,
      },
    ],
  });

  // Before dispute window expires: no payouts
  assert.equal(engine.runScheduledDistribution(startMs + 30_000).length, 0);

  // After dispute window expires, still below 300M threshold -> no payout yet
  assert.equal(engine.runScheduledDistribution(startMs + disputeWindowMs + 1).length, 0);

  // Round 2: invalidated by remediation before maturity
  engine.accrueRoundRewards({
    decisionId: "dec_r2_bad",
    feedId: "MarketCrash",
    roundNumber: 2,
    committedAtMs: startMs + 10_000,
    roundRewardPoolStroops: 200_000_000n,
    submissions: [
      {
        operatorId: "op_1",
        readingId: "r2",
        status: "included_in_consensus",
        stakeStroops: 100_000_000n,
        reputationScoreBps: 10_000,
      },
    ],
  });
  const invalidated = engine.invalidateDecisionRewards("dec_r2_bad", "retroactive_remediation");
  assert.equal(invalidated.length, 1);

  // Even after Round 2 maturity time, op_1 only has 200M valid matured (< 300M threshold)
  assert.equal(engine.runScheduledDistribution(startMs + disputeWindowMs + 20_000).length, 0);

  // Round 3: adds another 150M valid reward to op_1 -> total valid matured becomes 350M >= 300M
  engine.accrueRoundRewards({
    decisionId: "dec_r3",
    feedId: "MarketCrash",
    roundNumber: 3,
    committedAtMs: startMs + 20_000,
    roundRewardPoolStroops: 150_000_000n,
    submissions: [
      {
        operatorId: "op_1",
        readingId: "r3",
        status: "included_in_consensus",
        stakeStroops: 100_000_000n,
        reputationScoreBps: 10_000,
      },
    ],
  });

  const payouts = engine.runScheduledDistribution(startMs + 20_000 + disputeWindowMs);
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0].operatorId, "op_1");
  assert.equal(payouts[0].amountStroops, 350_000_000n);

  const summary = engine.getOperatorRewardSummary("op_1", startMs + 20_000 + disputeWindowMs);
  assert.equal(summary.paidStroops, 350_000_000n);
  assert.equal(summary.invalidatedStroops, 200_000_000n);
  assert.equal(summary.maturedUnpaidStroops, 0n);
});
