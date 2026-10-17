import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FeedDegradedModeController } from "./degradedModePolicy.ts";

describe("FeedDegradedModeController (Issue #195)", () => {
  it("evaluates all decision matrix states (quorum_shortfall, zero_fresh_sources, all_sources_divergent, consensus_engine_unavailable) and stays healthy on partial outage when quorum is met", () => {
    const controller = new FeedDegradedModeController();
    const t0 = 1_700_000_000_000;

    // 1. Partial outage: 4 configured, 3 fresh and agreeing, required quorum 3 -> stays healthy!
    const partialOk = controller.evaluateFeedTick({
      coverageType: "stablecoin_depeg",
      totalConfiguredSources: 4,
      freshSourcesCount: 3,
      agreeingSourcesCount: 3,
      requiredQuorumSources: 3,
      consensusEngineAvailable: true,
      agreedValue: 0.999,
      nowMs: t0,
    });
    assert.equal(partialOk.state, "healthy");
    assert.equal(partialOk.allowOnChainPayoutPublish, true);
    assert.equal(partialOk.allowClaimSettlement, true);

    // 2. Quorum shortfall (2 fresh < 3 required) -> degraded
    const shortfall = controller.evaluateFeedTick({
      coverageType: "stablecoin_depeg",
      totalConfiguredSources: 4,
      freshSourcesCount: 2,
      agreeingSourcesCount: 2,
      requiredQuorumSources: 3,
      consensusEngineAvailable: true,
      nowMs: t0 + 5_000,
    });
    assert.equal(shortfall.state, "degraded");
    assert.equal(shortfall.reasonCode, "quorum_shortfall");
    assert.equal(shortfall.allowOnChainPayoutPublish, false);
    assert.equal(shortfall.allowClaimSettlement, false);

    // 3. All sources divergent (3 fresh, only 1 agreeing < 3 required) -> degraded
    const divergent = controller.evaluateFeedTick({
      coverageType: "stablecoin_depeg",
      totalConfiguredSources: 4,
      freshSourcesCount: 3,
      agreeingSourcesCount: 1,
      requiredQuorumSources: 3,
      consensusEngineAvailable: true,
      nowMs: t0 + 10_000,
    });
    assert.equal(divergent.state, "degraded");
    assert.equal(divergent.reasonCode, "all_sources_divergent");

    // 4. Zero fresh sources -> paused
    const zeroSources = controller.evaluateFeedTick({
      coverageType: "stablecoin_depeg",
      totalConfiguredSources: 4,
      freshSourcesCount: 0,
      agreeingSourcesCount: 0,
      requiredQuorumSources: 3,
      consensusEngineAvailable: true,
      nowMs: t0 + 15_000,
    });
    assert.equal(zeroSources.state, "paused");
    assert.equal(zeroSources.reasonCode, "zero_fresh_sources");

    // 5. Consensus engine unavailable -> paused
    const engineDown = controller.evaluateFeedTick({
      coverageType: "stablecoin_depeg",
      totalConfiguredSources: 4,
      freshSourcesCount: 4,
      agreeingSourcesCount: 4,
      requiredQuorumSources: 3,
      consensusEngineAvailable: false,
      nowMs: t0 + 20_000,
    });
    assert.equal(engineDown.state, "paused");
    assert.equal(engineDown.reasonCode, "consensus_engine_unavailable");
  });

  it("blocks pending claims with reason codes during degraded mode, preserves already-settled claims, and settles blocked claims when quorum recovers", () => {
    const controller = new FeedDegradedModeController();
    const t0 = 1_700_000_000_000;

    // Register a claim that triggers when depeg price < 0.95
    controller.registerClaim({
      claimId: "claim-prior",
      coverageType: "stablecoin_depeg",
      payoutConditionMet: (val) => val < 0.95,
      nowMs: t0,
    });

    // Healthy tick triggers and settles claim-prior
    controller.evaluateFeedTick({
      coverageType: "stablecoin_depeg",
      totalConfiguredSources: 3,
      freshSourcesCount: 3,
      agreeingSourcesCount: 3,
      requiredQuorumSources: 3,
      consensusEngineAvailable: true,
      agreedValue: 0.91,
      nowMs: t0 + 1_000,
    });
    assert.equal(controller.getClaim("claim-prior")?.state, "settled_payout");

    // Feed enters degraded mode (quorum_shortfall)
    controller.evaluateFeedTick({
      coverageType: "stablecoin_depeg",
      totalConfiguredSources: 3,
      freshSourcesCount: 1,
      agreeingSourcesCount: 1,
      requiredQuorumSources: 3,
      consensusEngineAvailable: true,
      agreedValue: null,
      nowMs: t0 + 5_000,
    });

    // Already-settled claim-prior is preserved; new claim-during-outage is marked blocked_degraded_trust (NOT dropped or not_triggered)
    assert.equal(controller.getClaim("claim-prior")?.state, "settled_payout");

    controller.registerClaim({
      claimId: "claim-during-outage",
      coverageType: "stablecoin_depeg",
      payoutConditionMet: (val) => val < 0.95,
      nowMs: t0 + 6_000,
    });
    const blocked = controller.evaluateClaim(
      "claim-during-outage",
      0.88, // even if a single uncorroborated source reported 0.88, degraded mode blocks it!
      t0 + 6_500
    );
    assert.equal(blocked.state, "blocked_degraded_trust");
    assert.equal(blocked.blockedReasonCode, "quorum_shortfall");

    // Quorum is restored at t0 + 15_000 with corroborated value 0.92 -> blocked claim automatically settles!
    controller.evaluateFeedTick({
      coverageType: "stablecoin_depeg",
      totalConfiguredSources: 3,
      freshSourcesCount: 3,
      agreeingSourcesCount: 3,
      requiredQuorumSources: 3,
      consensusEngineAvailable: true,
      agreedValue: 0.92,
      nowMs: t0 + 15_000,
    });

    const recovered = controller.getClaim("claim-during-outage");
    assert.equal(recovered?.state, "settled_payout");
    assert.equal(recovered?.corroboratedValueAtTrigger, 0.92);
    assert.equal(recovered?.blockedReasonCode, undefined);
  });
});
