import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { EventEmitter } from 'events';
import {
  TRUST_REDIS_CHANNEL,
  TRUST_SNAPSHOT_KEY,
  TrustEnvelope,
  TrustEnvelopeSchema,
  TrustEventBus,
  TrustEventInput,
  buildEnvelope,
  snapshotKey,
} from './trust-events';

/**
 * Redis-backed trust event bus. Every instance (including the publisher)
 * broadcasts only what it receives from Redis pub-sub, so each event is
 * delivered exactly once per instance. Without Redis it falls back to
 * in-process delivery. Delivery is at-least-once; clients dedupe by `id`.
 */
@Injectable()
export class TrustEventsService
  implements TrustEventBus, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(TrustEventsService.name);
  private readonly emitter = new EventEmitter();
  private readonly snapshot = new Map<string, TrustEnvelope>();
  private readonly seen = new Set<string>();
  private pub?: Redis;
  private sub?: Redis;

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  async onModuleInit(): Promise<void> {
    const url = process.env.REDIS_URL;
    if (!url && !process.env.REDIS_HOST) return;
    const make = (): Redis =>
      url
        ? new Redis(url)
        : new Redis({
            host: process.env.REDIS_HOST,
            port: Number(process.env.REDIS_PORT ?? 6379),
            password: process.env.REDIS_PASSWORD,
          });
    this.pub = make();
    this.sub = make();
    for (const c of [this.pub, this.sub]) {
      c.on('error', (e) => this.logger.error(`Redis error: ${e.message}`));
    }
    try {
      const stored = await this.pub.hgetall(TRUST_SNAPSHOT_KEY);
      for (const [k, v] of Object.entries(stored)) {
        const parsed = TrustEnvelopeSchema.safeParse(JSON.parse(v));
        if (parsed.success) this.snapshot.set(k, parsed.data as TrustEnvelope);
      }
    } catch (err) {
      this.logger.warn(`Snapshot hydrate failed: ${(err as Error).message}`);
    }
    this.sub.on('message', (_ch, raw) => this.receive(raw));
    await this.sub.subscribe(TRUST_REDIS_CHANNEL);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.pub?.quit(), this.sub?.quit()]);
  }

  async publish(input: TrustEventInput): Promise<void> {
    const envelope = buildEnvelope(input);
    const key = snapshotKey(input);
    const raw = JSON.stringify({ ...envelope, snapshotKey: key });
    if (!this.pub) {
      this.receive(raw);
      return;
    }
    await this.pub.hset(TRUST_SNAPSHOT_KEY, key, JSON.stringify(envelope));
    await this.pub.publish(TRUST_REDIS_CHANNEL, raw);
  }

  /** Current-state snapshot: latest event per subject. */
  getSnapshot(): TrustEnvelope[] {
    return [...this.snapshot.values()];
  }

  onEvent(listener: (e: TrustEnvelope) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  private receive(raw: string): void {
    try {
      const { snapshotKey: key, ...rest } = JSON.parse(raw);
      const parsed = TrustEnvelopeSchema.safeParse(rest);
      if (!parsed.success) return;
      const envelope = parsed.data as TrustEnvelope;
      if (this.seen.has(envelope.id)) return;
      this.seen.add(envelope.id);
      if (this.seen.size > 5000) {
        this.seen.delete(this.seen.values().next().value as string);
      }
      this.snapshot.set(key ?? snapshotKey(envelope), envelope);
      this.emitter.emit('event', envelope);
    } catch (err) {
      this.logger.warn(`Dropped malformed trust event: ${(err as Error).message}`);
    }
  }
}
