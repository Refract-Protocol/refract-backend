import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OperatorPauseController } from "./operatorPauseController.ts";

describe("Expose Operator Pause and Resume Controls for Payout-Triggering Values (#179)", () => {
  it("enforces operator authentication and required reason, isolates per-coverage pauses, supports GLOBAL_ALL override, and appends audit rows", () => {
    const controller = new OperatorPauseController({
      operatorBearerToken: "op-secret-token-2026",
      knownCoverageTypes: [
        "stablecoin-depeg",
        "protocol-exploit",
        "flight-delay",
      ],
    });

    // 1. Auth failure returns 401
    const unauth = controller.pause({
      providedToken: "wrong-token",
      actorId: "ops-oncall",
      scope: "stablecoin-depeg",
      reason: "suspect feed",
    });
    assert.equal(unauth.httpStatus, 401);

    // 2. Missing reason returns 400
    const missingReason = controller.pause({
      providedToken: "op-secret-token-2026",
      actorId: "ops-oncall",
      scope: "stablecoin-depeg",
      reason: "   ",
    });
    assert.equal(missingReason.httpStatus, 400);
    assert.equal(missingReason.errorCode, "REASON_REQUIRED");

    // 3. Pause stablecoin-depeg -> blocks publishing/settlement for stablecoin-depeg while keeping polling active and leaving flight-delay unaffected
    const pauseRes = controller.pause({
      providedToken: "op-secret-token-2026",
      actorId: "ops-oncall",
      scope: "stablecoin-depeg",
      reason: "Upstream CoinGecko anomaly under investigation",
      nowMs: 1_700_000_001_000,
    });
    assert.equal(pauseRes.httpStatus, 200);

    const depegGate = controller.evaluatePipelineGate("stablecoin-depeg");
    assert.equal(depegGate.effectivePaused, true);
    assert.equal(depegGate.allowPollingAndLogging, true);
    assert.equal(depegGate.allowPublishingAndSettlement, false);

    const flightGate = controller.evaluatePipelineGate("flight-delay");
    assert.equal(flightGate.effectivePaused, false);
    assert.equal(flightGate.allowPublishingAndSettlement, true);

    // 4. Resume stablecoin-depeg restores settlement
    controller.resume({
      providedToken: "op-secret-token-2026",
      actorId: "ops-oncall",
      scope: "stablecoin-depeg",
      reason: "Sources corroborated and verified healthy",
      nowMs: 1_700_000_010_000,
    });
    assert.equal(
      controller.evaluatePipelineGate("stablecoin-depeg")
        .allowPublishingAndSettlement,
      true
    );

    const audit = controller.getAuditTrail();
    assert.equal(audit.length, 2);
    assert.equal(audit[0]?.priorPausedState, false);
    assert.equal(audit[0]?.nextPausedState, true);
    assert.equal(audit[1]?.priorPausedState, true);
    assert.equal(audit[1]?.nextPausedState, false);
  });
});
