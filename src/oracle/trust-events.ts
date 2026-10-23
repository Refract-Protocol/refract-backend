import { randomUUID } from 'crypto';
import { z } from 'zod';

export const TRUST_SCHEMA_VERSION = 1;
export const TRUST_REDIS_CHANNEL = 'refract:trust-events';
export const TRUST_SNAPSHOT_KEY = 'refract:trust-snapshot';

export const TRUST_CHANNELS = [
  'trust.source',
  'trust.feed',
  'trust.coverage',
  'trust.pause',
  'trust.dispute',
] as const;
export type TrustChannel = (typeof TRUST_CHANNELS)[number];

const subject = z.string().min(1).max(128);

/**
 * Public payloads. Zod object schemas strip unknown keys, so internal fields
 * (provider URLs, API keys, operator ids, ...) can never leak by accident.
 */
const PUBLIC_PAYLOADS = {
  'trust.source': z.object({
    kind: z.enum(['quarantined', 'restored']),
    feedId: subject,
    coverageType: subject.optional(),
    reason: z.string().max(256).optional(),
  }),
  'trust.feed': z.object({
    kind: z.enum(['divergence', 'quorum_failure', 'confidence_change']),
    feedId: subject,
    coverageType: subject.optional(),
    confidence: z.number().min(0).max(1).optional(),
    degraded: z.boolean(),
  }),
  'trust.coverage': z.object({
    coverageType: subject,
    degraded: z.boolean(),
    confidence: z.number().min(0).max(1).optional(),
  }),
  'trust.pause': z.object({
    kind: z.enum(['paused', 'resumed']),
    coverageType: subject.optional(),
    reason: z.string().max(256).optional(),
  }),
  'trust.dispute': z.object({
    kind: z.literal('opened'),
    coverageType: subject.optional(),
    disputeId: subject,
  }),
} as const;

/** Ops-only extras, delivered solely to authenticated clients. */
const InternalSchema = z
  .object({
    sourceId: subject.optional(),
    detail: z.string().max(1024).optional(),
    actor: subject.optional(),
  })
  .strip();

export const TrustEnvelopeSchema = z.object({
  id: z.string().min(1),
  version: z.literal(TRUST_SCHEMA_VERSION),
  type: z.enum(TRUST_CHANNELS),
  timestamp: z.string(),
  payload: z.record(z.unknown()),
  internal: InternalSchema.optional(),
});

export interface TrustEnvelope {
  id: string;
  version: number;
  type: TrustChannel;
  timestamp: string;
  payload: Record<string, unknown>;
  /** Ops-only; removed by {@link redactEnvelope} for public clients. */
  internal?: z.infer<typeof InternalSchema>;
}

export interface TrustEventInput {
  type: TrustChannel;
  payload: Record<string, unknown>;
  internal?: Record<string, unknown>;
  /** Snapshot key; the latest event per key forms the connect-time snapshot. */
  key?: string;
}

/** Validates and builds an envelope; throws if the payload is invalid. */
export function buildEnvelope(input: TrustEventInput): TrustEnvelope {
  const payload = PUBLIC_PAYLOADS[input.type].parse(input.payload);
  return TrustEnvelopeSchema.parse({
    id: randomUUID(),
    version: TRUST_SCHEMA_VERSION,
    type: input.type,
    timestamp: new Date().toISOString(),
    payload,
    internal: input.internal ? InternalSchema.parse(input.internal) : undefined,
  }) as TrustEnvelope;
}

/** Public-safe view: re-validates the payload and drops `internal`. */
export function redactEnvelope(envelope: TrustEnvelope): TrustEnvelope {
  return {
    id: envelope.id,
    version: envelope.version,
    type: envelope.type,
    timestamp: envelope.timestamp,
    payload: PUBLIC_PAYLOADS[envelope.type].parse(envelope.payload),
  };
}

export function snapshotKey(input: {
  type: TrustChannel;
  payload: Record<string, unknown>;
  key?: string;
}): string {
  if (input.key) return `${input.type}:${input.key}`;
  const p = input.payload;
  return `${input.type}:${String(p.feedId ?? p.coverageType ?? p.disputeId ?? '*')}`;
}

/** Internal bus services call when they mutate trust state. */
export interface TrustEventBus {
  publish(input: TrustEventInput): Promise<void>;
}

export const TRUST_EVENT_BUS = 'TRUST_EVENT_BUS';
