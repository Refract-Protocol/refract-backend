export type TrustEventChannel =
  | "trust.source"
  | "trust.feed"
  | "trust.coverage"
  | "trust.pause"
  | "trust.dispute"
  | "trust.snapshot";

export interface TrustEventEnvelope {
  schemaVersion: "1.0";
  eventId: string;
  channel: TrustEventChannel;
  feedId: string;
  timestampMs: number;
  resyncRequired?: boolean;
  payload: Record<string, unknown>;
}

interface ConnectedSubscriber {
  clientId: string;
  authenticated: boolean;
  subscribedFeeds: Set<string>;
  subscribedChannels: Set<TrustEventChannel>;
  outboundBuffer: TrustEventEnvelope[];
}

const INTERNAL_OR_SECRET_KEYS = new Set([
  "operatoremail",
  "internalnote",
  "apikey",
  "secret",
  "privatekey",
  "rawcredential",
]);

function sanitizePayloadForClient(
  payload: Record<string, unknown>,
  authenticated: boolean
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    const lower = k.toLowerCase();
    // Never leak secrets to anyone; strip internal operator metadata for unauthenticated clients
    if (
      lower === "apikey" ||
      lower === "secret" ||
      lower === "privatekey" ||
      lower === "rawcredential"
    ) {
      continue;
    }
    if (!authenticated && INTERNAL_OR_SECRET_KEYS.has(lower)) {
      continue;
    }
    sanitized[k] = v;
  }
  return sanitized;
}

export class OracleTrustEventStreamHub {
  private readonly maxBufferSizePerClient: number;
  private readonly clients = new Map<string, ConnectedSubscriber>();
  private readonly feedSnapshots = new Map<string, Record<string, unknown>>();
  private readonly seenEventIds = new Set<string>();

  constructor(options?: { maxBufferSizePerClient?: number }) {
    this.maxBufferSizePerClient = options?.maxBufferSizePerClient ?? 32;
  }

  public updateFeedSnapshot(
    feedId: string,
    snapshotState: Record<string, unknown>
  ): void {
    this.feedSnapshots.set(feedId, { ...snapshotState });
  }

  public connectAndSubscribe(params: {
    clientId: string;
    authenticated: boolean;
    feeds: string[];
    channels: TrustEventChannel[];
    nowMs?: number;
  }): TrustEventEnvelope[] {
    const nowMs = params.nowMs ?? Date.now();
    const subscriber: ConnectedSubscriber = {
      clientId: params.clientId,
      authenticated: params.authenticated,
      subscribedFeeds: new Set(params.feeds),
      subscribedChannels: new Set(params.channels),
      outboundBuffer: [],
    };
    this.clients.set(params.clientId, subscriber);

    // Push immediate current-state snapshot for each subscribed feed on connect
    for (const feedId of params.feeds) {
      const snap = this.feedSnapshots.get(feedId) ?? {
        feedId,
        status: "unknown",
      };
      this.enqueueToClient(subscriber, {
        schemaVersion: "1.0",
        eventId: `snap:${params.clientId}:${feedId}:${nowMs}`,
        channel: "trust.snapshot",
        feedId,
        timestampMs: nowMs,
        payload: sanitizePayloadForClient(snap, subscriber.authenticated),
      });
    }

    return [...subscriber.outboundBuffer];
  }

  public publishEvent(event: {
    eventId: string;
    channel: Exclude<TrustEventChannel, "trust.snapshot">;
    feedId: string;
    timestampMs: number;
    payload: Record<string, unknown>;
  }): { deliveredClients: number; deduplicated: boolean } {
    if (this.seenEventIds.has(event.eventId)) {
      return { deliveredClients: 0, deduplicated: true };
    }
    this.seenEventIds.add(event.eventId);

    let deliveredClients = 0;
    for (const sub of this.clients.values()) {
      if (
        !sub.subscribedFeeds.has(event.feedId) ||
        !sub.subscribedChannels.has(event.channel)
      ) {
        continue;
      }

      this.enqueueToClient(sub, {
        schemaVersion: "1.0",
        eventId: event.eventId,
        channel: event.channel,
        feedId: event.feedId,
        timestampMs: event.timestampMs,
        payload: sanitizePayloadForClient(event.payload, sub.authenticated),
      });
      deliveredClients += 1;
    }

    return { deliveredClients, deduplicated: false };
  }

  private enqueueToClient(
    sub: ConnectedSubscriber,
    envelope: TrustEventEnvelope
  ): void {
    if (sub.outboundBuffer.length >= this.maxBufferSizePerClient) {
      // Slow-consumer handling: drop oldest and mark resyncRequired on the newly queued envelope
      sub.outboundBuffer.shift();
      envelope = { ...envelope, resyncRequired: true };
    }
    sub.outboundBuffer.push(envelope);
  }

  public drainClientBuffer(clientId: string): TrustEventEnvelope[] {
    const sub = this.clients.get(clientId);
    if (!sub) return [];
    const drained = [...sub.outboundBuffer];
    sub.outboundBuffer.length = 0;
    return drained;
  }
}
