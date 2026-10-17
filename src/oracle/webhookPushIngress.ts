import { createHmac, timingSafeEqual } from "node:crypto";

export type ProviderIngestionMode = "poll_only" | "push_only" | "hybrid";

export interface WebhookPushPayload {
  deliveryId: string;
  feedId: string;
  canonicalValue: number;
  observedAtMs: number;
  metadata?: Record<string, unknown>;
}

export interface RegisteredPushProvider {
  providerId: string;
  mode: ProviderIngestionMode;
  hmacSecret: string;
  maxSkewMs?: number;
  maxRequestsPerMinute?: number;
}

export interface NormalizedWebhookReading {
  providerId: string;
  deliveryId: string;
  feedId: string;
  canonicalValue: number;
  observedAtMs: number;
  receivedAtMs: number;
}

export interface WebhookIngressResult {
  httpStatus: 202 | 401 | 429;
  accepted: boolean;
  reasonCode:
    | "ACCEPTED_QUEUED"
    | "AUTH_OR_REPLAY_REJECTED"
    | "RATE_LIMITED";
  publicMessage: string;
}

export class WebhookPushIngressController {
  private readonly providers = new Map<string, RegisteredPushProvider>();
  private readonly seenDeliveries = new Map<string, number>();
  private readonly providerRequestTimestamps = new Map<string, number[]>();
  private readonly ingestionQueue: NormalizedWebhookReading[] = [];

  public registerProvider(config: RegisteredPushProvider): void {
    this.providers.set(config.providerId, config);
  }

  /**
   * Returns only providers that should be scheduled by the polling loop
   * (`poll_only` or `hybrid`). `push_only` providers are excluded from polling.
   */
  public getPollableProviderIds(): string[] {
    const pollable: string[] = [];
    for (const [id, cfg] of this.providers.entries()) {
      if (cfg.mode === "poll_only" || cfg.mode === "hybrid") {
        pollable.push(id);
      }
    }
    return pollable;
  }

  public static signWebhookPayload(
    secret: string,
    timestampMs: number,
    rawBody: string
  ): string {
    return createHmac("sha256", secret)
      .update(`${timestampMs}.${rawBody}`)
      .digest("hex");
  }

  public ingestWebhook(params: {
    providerId: string;
    signatureHex: string;
    timestampMs: number;
    rawBody: string;
    nowMs?: number;
  }): WebhookIngressResult {
    const nowMs = params.nowMs ?? Date.now();
    const genericReject: WebhookIngressResult = {
      httpStatus: 401,
      accepted: false,
      reasonCode: "AUTH_OR_REPLAY_REJECTED",
      publicMessage: "Webhook delivery rejected",
    };

    const provider = this.providers.get(params.providerId);
    if (!provider || provider.mode === "poll_only") {
      // Do not leak whether providerId exists or is poll-only
      return genericReject;
    }

    const maxSkewMs = provider.maxSkewMs ?? 300_000;
    if (
      !Number.isFinite(params.timestampMs) ||
      Math.abs(nowMs - params.timestampMs) > maxSkewMs
    ) {
      return genericReject;
    }

    const expectedHex = WebhookPushIngressController.signWebhookPayload(
      provider.hmacSecret,
      params.timestampMs,
      params.rawBody
    );

    const expectedBuf = Buffer.from(expectedHex, "utf8");
    const providedBuf = Buffer.from(params.signatureHex || "", "utf8");
    if (
      expectedBuf.length !== providedBuf.length ||
      !timingSafeEqual(expectedBuf, providedBuf)
    ) {
      return genericReject;
    }

    // Per-provider sliding-window rate limit
    const maxRpm = provider.maxRequestsPerMinute ?? 60;
    const recentTimestamps = (
      this.providerRequestTimestamps.get(provider.providerId) ?? []
    ).filter((t) => nowMs - t < 60_000);
    if (recentTimestamps.length >= maxRpm) {
      this.providerRequestTimestamps.set(provider.providerId, recentTimestamps);
      return {
        httpStatus: 429,
        accepted: false,
        reasonCode: "RATE_LIMITED",
        publicMessage: "Rate limit exceeded",
      };
    }

    let parsed: WebhookPushPayload;
    try {
      parsed = JSON.parse(params.rawBody) as WebhookPushPayload;
    } catch {
      return genericReject;
    }

    if (
      !parsed ||
      typeof parsed.deliveryId !== "string" ||
      parsed.deliveryId.trim().length === 0 ||
      typeof parsed.feedId !== "string" ||
      parsed.feedId.trim().length === 0 ||
      typeof parsed.canonicalValue !== "number" ||
      !Number.isFinite(parsed.canonicalValue) ||
      typeof parsed.observedAtMs !== "number" ||
      !Number.isFinite(parsed.observedAtMs)
    ) {
      return genericReject;
    }

    // Evict expired replay keys and check `(providerId, deliveryId)`
    for (const [k, seenAt] of this.seenDeliveries.entries()) {
      if (nowMs - seenAt > maxSkewMs * 2) {
        this.seenDeliveries.delete(k);
      }
    }
    const replayKey = `${provider.providerId}:${parsed.deliveryId}`;
    if (this.seenDeliveries.has(replayKey)) {
      return genericReject;
    }

    this.seenDeliveries.set(replayKey, nowMs);
    recentTimestamps.push(nowMs);
    this.providerRequestTimestamps.set(provider.providerId, recentTimestamps);

    this.ingestionQueue.push({
      providerId: provider.providerId,
      deliveryId: parsed.deliveryId,
      feedId: parsed.feedId,
      canonicalValue: parsed.canonicalValue,
      observedAtMs: parsed.observedAtMs,
      receivedAtMs: nowMs,
    });

    return {
      httpStatus: 202,
      accepted: true,
      reasonCode: "ACCEPTED_QUEUED",
      publicMessage: "Accepted",
    };
  }

  public drainQueuedReadings(): NormalizedWebhookReading[] {
    return this.ingestionQueue.splice(0, this.ingestionQueue.length);
  }
}
