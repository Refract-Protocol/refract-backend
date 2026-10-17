import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SourceReliabilityTracker } from "./sourceReliabilityTracker.ts";

describe("Track Per-Source Reliability and Auto-Quarantine Divergent or Failing Feeds (#187)", () => {
  it("transitions sources through healthy -> degraded -> quarantined with hysteresis and auto-recovers after trailing window clears", () => {
    const tracker = new SourceReliabilityTracker({
      windowSize: 4,
      degradeConsecutiveFailures: 2,
      quarantineConsecutiveFailures: 4,
      quarantineDivergenceRate: 0.75,
      divergenceBandRatio: 0.02,
      recoverAfterCleanPolls: 3,
    });

    // 1. Single failure does not flap state out of healthy
    const s1 = tracker.recordPollOutcome({
      sourceId: "noisy-source",
      failed: true,
    });
    assert.equal(s1.state, "healthy");

    // 2. Second consecutive failure moves state to degraded
    const s2 = tracker.recordPollOutcome({
      sourceId: "noisy-source",
      failed: true,
    });
    assert.equal(s2.state, "degraded");
    assert.equal(s2.eligibleForConsensus, true);

    // 3. 3rd and 4th consecutive failures move state to quarantined (excluded from consensus)
    tracker.recordPollOutcome({ sourceId: "noisy-source", failed: true });
    const s4 = tracker.recordPollOutcome({
      sourceId: "noisy-source",
      failed: true,
    });
    assert.equal(s4.state, "quarantined");
    assert.equal(s4.eligibleForConsensus, false);

    // 4. Shadow polling continues while quarantined: 2 clean in-band polls are not yet enough (< 3)
    const r1 = tracker.recordPollOutcome({
      sourceId: "noisy-source",
      failed: false,
      observedValue: 1.0,
      consensusValue: 1.0,
    });
    assert.equal(r1.state, "quarantined");

    const r2 = tracker.recordPollOutcome({
      sourceId: "noisy-source",
      failed: false,
      observedValue: 1.0001,
      consensusValue: 1.0,
    });
    assert.equal(r2.state, "quarantined");

    // 3rd consecutive clean in-band poll restores source to healthy
    const r3 = tracker.recordPollOutcome({
      sourceId: "noisy-source",
      failed: false,
      observedValue: 0.9999,
      consensusValue: 1.0,
    });
    assert.equal(r3.state, "healthy");
    assert.equal(r3.eligibleForConsensus, true);
  });

  it("supports operator manual overrides and alerts rather than black-holing a sole participant source", () => {
    const tracker = new SourceReliabilityTracker({
      quarantineConsecutiveFailures: 2,
    });

    // Sole participant on feed degrades and emits SOLE_SOURCE_DEGRADATION_ALERT instead of silent quarantine
    tracker.recordPollOutcome({
      sourceId: "sole-flight-source",
      failed: true,
      soleParticipantOnFeed: true,
    });
    const soleSnap = tracker.recordPollOutcome({
      sourceId: "sole-flight-source",
      failed: true,
      soleParticipantOnFeed: true,
    });
    assert.equal(soleSnap.state, "degraded");
    assert.equal(soleSnap.eligibleForConsensus, true);
    assert.equal(tracker.getSoleSourceAlerts().length, 1);

    // Operator manual force_quarantine override
    const overridden = tracker.setManualOverride({
      sourceId: "suspect-provider",
      mode: "force_quarantine",
      actorId: "ops-admin",
      reason: "Certificate rotation mismatch",
    });
    assert.equal(overridden.state, "quarantined");
    assert.equal(overridden.eligibleForConsensus, false);
    assert.equal(overridden.manualOverrideActor, "ops-admin");
  });
});
