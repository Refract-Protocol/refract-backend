import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebhookPushIngressController } from "./webhookPushIngress.ts";

describe("Webhook/Push Provider Sources Alongside Polling (#231)", () => {
  it("excludes push_only providers from polling schedule and verifies HMAC-SHA256 signatures, replay protection, and generic errors", () => {
    const controller = new WebhookPushIngressController();
    controller.registerProvider({
      providerId: "coingecko-poll",
      mode: "poll_only",
      hmacSecret: "unused-poll-secret",
    });
    controller.registerProvider({
      providerId: "flightaware-webhook",
      mode: "push_only",
      hmacSecret: "super-secret-key",
      maxSkewMs: 60_000,
      maxRequestsPerMinute: 2,
    });
    controller.registerProvider({
      providerId: "pyth-hybrid",
      mode: "hybrid",
      hmacSecret: "hybrid-secret",
    });

    assert.deepEqual(controller.getPollableProviderIds().sort(), [
      "coingecko-poll",
      "pyth-hybrid",
    ]);

    const nowMs = 1_700_000_000_000;
    const rawBody = JSON.stringify({
      deliveryId: "deliv-001",
      feedId: "FLIGHT_UA123",
      canonicalValue: 1,
      observedAtMs: nowMs - 1_000,
    });
    const validSig = WebhookPushIngressController.signWebhookPayload(
      "super-secret-key",
      nowMs,
      rawBody
    );

    // 1. Valid push delivery is queued with 202 Accepted
    const okRes = controller.ingestWebhook({
      providerId: "flightaware-webhook",
      signatureHex: validSig,
      timestampMs: nowMs,
      rawBody,
      nowMs,
    });
    assert.equal(okRes.httpStatus, 202);
    assert.equal(okRes.accepted, true);

    const drained = controller.drainQueuedReadings();
    assert.equal(drained.length, 1);
    assert.equal(drained[0]?.deliveryId, "deliv-001");

    // 2. Duplicate deliveryId is rejected as replay without leaking internal details
    const replayRes = controller.ingestWebhook({
      providerId: "flightaware-webhook",
      signatureHex: validSig,
      timestampMs: nowMs,
      rawBody,
      nowMs,
    });
    assert.equal(replayRes.httpStatus, 401);
    assert.equal(replayRes.publicMessage, "Webhook delivery rejected");

    // 3. Unknown providerId returns identical generic 401 message (no enumeration leak)
    const unknownRes = controller.ingestWebhook({
      providerId: "unregistered-provider",
      signatureHex: validSig,
      timestampMs: nowMs,
      rawBody,
      nowMs,
    });
    assert.equal(unknownRes.httpStatus, 401);
    assert.equal(unknownRes.publicMessage, "Webhook delivery rejected");
  });

  it("enforces per-provider sliding-window rate limits and rejects stale timestamps", () => {
    const controller = new WebhookPushIngressController();
    controller.registerProvider({
      providerId: "liquidation-push",
      mode: "push_only",
      hmacSecret: "liq-secret",
      maxSkewMs: 30_000,
      maxRequestsPerMinute: 2,
    });

    const nowMs = 1_700_000_000_000;
    const sendDelivery = (deliveryId: string, timestampMs: number) => {
      const rawBody = JSON.stringify({
        deliveryId,
        feedId: "BTC_LIQ",
        canonicalValue: 500_000,
        observedAtMs: timestampMs,
      });
      const sig = WebhookPushIngressController.signWebhookPayload(
        "liq-secret",
        timestampMs,
        rawBody
      );
      return controller.ingestWebhook({
        providerId: "liquidation-push",
        signatureHex: sig,
        timestampMs,
        rawBody,
        nowMs,
      });
    };

    // Stale timestamp outside 30s skew is rejected
    const stale = sendDelivery("d-stale", nowMs - 45_000);
    assert.equal(stale.httpStatus, 401);

    // Two valid requests succeed, third within 60s hits 429 rate limit
    assert.equal(sendDelivery("d-1", nowMs).httpStatus, 202);
    assert.equal(sendDelivery("d-2", nowMs).httpStatus, 202);
    assert.equal(sendDelivery("d-3", nowMs).httpStatus, 429);
  });
});
