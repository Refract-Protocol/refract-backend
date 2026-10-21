import { PushOracleSource, SourceReading, WebhookCredential } from "./oracle-source";

/**
 * Push source for providers that send our canonical JSON body:
 *
 *   { "readings": [ { "feedId": "usdc-usd", "coverageType": "StablecoinDepeg",
 *                     "value": 0.9991, "observedAt": 1760000000000, "sequence": 42 } ] }
 *
 * Providers with their own format get their own PushOracleSource.parse().
 */
export class JsonPushSource implements PushOracleSource {
  readonly mode = "push" as const;

  constructor(
    readonly id: string,
    readonly feeds: readonly string[],
    readonly credentials: readonly WebhookCredential[],
  ) {}

  parse(body: unknown): SourceReading[] {
    if (!body || typeof body !== "object" || !Array.isArray((body as { readings?: unknown }).readings)) {
      throw new Error("body.readings must be an array");
    }
    return (body as { readings: unknown[] }).readings.map((raw, i) => {
      if (!raw || typeof raw !== "object") throw new Error(`readings[${i}] must be an object`);
      const r = raw as Record<string, unknown>;
      if (typeof r.feedId !== "string" || typeof r.coverageType !== "string") throw new Error(`readings[${i}] missing feedId/coverageType`);
      if (typeof r.value !== "number" || typeof r.observedAt !== "number") throw new Error(`readings[${i}] value/observedAt must be numbers`);
      if (r.sequence !== undefined && (typeof r.sequence !== "number" || !Number.isInteger(r.sequence))) {
        throw new Error(`readings[${i}].sequence must be an integer`);
      }
      return {
        feedId: r.feedId,
        coverageType: r.coverageType,
        value: r.value,
        observedAt: r.observedAt,
        ...(r.sequence !== undefined ? { sequence: r.sequence as number } : {}),
      };
    });
  }
}

interface PushSourceEnvEntry {
  id: string;
  feeds: string[];
  keys: WebhookCredential[];
}

/**
 * Builds push sources from ORACLE_PUSH_SOURCES, a JSON array of
 * { id, feeds: string[], keys: [{ keyId, secret, notBefore?, notAfter? }] }.
 * Throws on malformed config so a bad deploy fails at boot, not at first delivery.
 */
export function pushSourcesFromEnv(raw: string | undefined): JsonPushSource[] {
  if (!raw || raw.trim() === "") return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("ORACLE_PUSH_SOURCES must be a JSON array");
  return parsed.map((entry: PushSourceEnvEntry, i) => {
    if (!entry || typeof entry.id !== "string" || !Array.isArray(entry.feeds) || !Array.isArray(entry.keys)) {
      throw new Error(`ORACLE_PUSH_SOURCES[${i}] must have id, feeds[] and keys[]`);
    }
    return new JsonPushSource(entry.id, entry.feeds, entry.keys);
  });
}
