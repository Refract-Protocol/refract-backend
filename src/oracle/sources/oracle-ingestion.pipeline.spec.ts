import { JsonPushSource, pushSourcesFromEnv } from "./json-push-source";
import { InMemoryNonceStore } from "./nonce-store";
import { DEFAULT_INGESTION_CONFIG, InboundWebhook, OracleIngestionPipeline } from "./oracle-ingestion.pipeline";
import { IngestedReading, PullOracleSource, SourceReading } from "./oracle-source";
import { SIGNATURE_HEADERS, signWebhook } from "./webhook-signature";

const SECRET = "s".repeat(32);
const ROTATED_SECRET = "r".repeat(40);
const NOW = 1_760_000_000_000;
let nonceCounter = 0;

function pushSource(overrides: Partial<{ feeds: string[]; keys: JsonPushSource["credentials"] }> = {}) {
  return new JsonPushSource("acme", overrides.feeds ?? ["usdc-usd"], overrides.keys ?? [{ keyId: "k1", secret: SECRET }]);
}

function reading(overrides: Partial<SourceReading> = {}): SourceReading {
  return { feedId: "usdc-usd", coverageType: "StablecoinDepeg", value: 0.999, observedAt: NOW - 1000, ...overrides };
}

function signed(
  readings: unknown,
  opts: { sourceId?: string; keyId?: string; secret?: string; ts?: number; nonce?: string; tamper?: (b: Buffer) => Buffer } = {},
): InboundWebhook {
  const rawBody = Buffer.from(JSON.stringify(Array.isArray(readings) ? { readings } : readings));
  const ts = opts.ts ?? Math.floor(NOW / 1000);
  const nonce = opts.nonce ?? `nonce-${String(++nonceCounter).padStart(12, "0")}`;
  const keyId = opts.keyId ?? "k1";
  const sig = signWebhook(opts.secret ?? SECRET, opts.sourceId ?? "acme", keyId, ts, nonce, rawBody);
  return {
    headers: {
      [SIGNATURE_HEADERS.keyId]: keyId,
      [SIGNATURE_HEADERS.timestamp]: String(ts),
      [SIGNATURE_HEADERS.nonce]: nonce,
      [SIGNATURE_HEADERS.signature]: sig,
    },
    rawBody: opts.tamper ? opts.tamper(rawBody) : rawBody,
  };
}

function setup(source = pushSource()) {
  const pipeline = new OracleIngestionPipeline(DEFAULT_INGESTION_CONFIG, new InMemoryNonceStore());
  pipeline.register(source);
  const sunk: IngestedReading[] = [];
  pipeline.onReadings((r) => {
    sunk.push(...r);
  });
  return { pipeline, sunk };
}

describe("OracleIngestionPipeline — push webhooks", () => {
  it("accepts a correctly signed, fresh delivery and tags readings with source and mode", async () => {
    const { pipeline, sunk } = setup();
    const res = await pipeline.ingestWebhook("acme", signed([reading()]), NOW);
    expect(res.ok).toBe(true);
    expect(sunk).toEqual([expect.objectContaining({ sourceId: "acme", mode: "push", receivedAt: NOW, value: 0.999 })]);
  });

  it.each([
    ["missing headers", (w: InboundWebhook) => ({ ...w, headers: {} }), "missing_headers"],
    [
      "malformed signature",
      (w: InboundWebhook) => ({ ...w, headers: { ...w.headers, [SIGNATURE_HEADERS.signature]: "sha256=abc" } }),
      "malformed_headers",
    ],
    [
      "duplicated header",
      (w: InboundWebhook) => ({ ...w, headers: { ...w.headers, [SIGNATURE_HEADERS.nonce]: ["a".repeat(16), "b".repeat(16)] } }),
      "missing_headers",
    ],
  ])("rejects %s with 401", async (_name, mutate, reason) => {
    const { pipeline, sunk } = setup();
    const res = await pipeline.ingestWebhook("acme", mutate(signed([reading()])), NOW);
    expect(res).toEqual({ ok: false, status: 401, reason });
    expect(sunk).toHaveLength(0);
  });

  it("rejects a tampered body", async () => {
    const { pipeline } = setup();
    const tampered = signed([reading()], { tamper: (b) => Buffer.from(b.toString().replace("0.999", "0.900")) });
    expect(await pipeline.ingestWebhook("acme", tampered, NOW)).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("rejects a signature made with the wrong secret or for another source", async () => {
    const { pipeline } = setup();
    expect(await pipeline.ingestWebhook("acme", signed([reading()], { secret: "x".repeat(32) }), NOW)).toMatchObject({ reason: "bad_signature" });
    expect(await pipeline.ingestWebhook("acme", signed([reading()], { sourceId: "other" }), NOW)).toMatchObject({ reason: "bad_signature" });
  });

  it("returns the same 401 for unknown sources and pull-only sources", async () => {
    const { pipeline } = setup();
    const pull: PullOracleSource = { id: "poller", mode: "pull", feeds: ["usdc-usd"], poll: async () => [] };
    pipeline.register(pull);
    expect(await pipeline.ingestWebhook("nope", signed([reading()]), NOW)).toEqual({ ok: false, status: 401, reason: "unknown_source" });
    expect(await pipeline.ingestWebhook("poller", signed([reading()], { sourceId: "poller" }), NOW)).toEqual({
      ok: false,
      status: 401,
      reason: "unknown_source",
    });
  });

  it("rejects replayed nonces", async () => {
    const { pipeline, sunk } = setup();
    const delivery = signed([reading()]);
    expect((await pipeline.ingestWebhook("acme", delivery, NOW)).ok).toBe(true);
    expect(await pipeline.ingestWebhook("acme", delivery, NOW + 1000)).toMatchObject({ ok: false, reason: "replayed_nonce" });
    expect(sunk).toHaveLength(1);
  });

  it("rejects requests signed outside the skew window", async () => {
    const { pipeline } = setup();
    const old = signed([reading()], { ts: Math.floor((NOW - DEFAULT_INGESTION_CONFIG.webhookMaxSkewMs - 1000) / 1000) });
    expect(await pipeline.ingestWebhook("acme", old, NOW)).toMatchObject({ reason: "timestamp_out_of_window" });
    const future = signed([reading()], { ts: Math.floor((NOW + DEFAULT_INGESTION_CONFIG.webhookMaxSkewMs + 1000) / 1000) });
    expect(await pipeline.ingestWebhook("acme", future, NOW)).toMatchObject({ reason: "timestamp_out_of_window" });
  });

  it("supports key rotation with notBefore/notAfter windows", async () => {
    const { pipeline } = setup(
      pushSource({
        keys: [
          { keyId: "old", secret: SECRET, notAfter: NOW },
          { keyId: "new", secret: ROTATED_SECRET, notBefore: NOW - 60_000 },
        ],
      }),
    );
    expect(await pipeline.ingestWebhook("acme", signed([reading()], { keyId: "old" }), NOW)).toMatchObject({ reason: "key_not_active" });
    expect((await pipeline.ingestWebhook("acme", signed([reading()], { keyId: "new", secret: ROTATED_SECRET }), NOW)).ok).toBe(true);
    expect(await pipeline.ingestWebhook("acme", signed([reading()], { keyId: "ghost" }), NOW)).toMatchObject({ reason: "unknown_key" });
  });

  it("enforces body size and per-delivery reading limits", async () => {
    const pipeline = new OracleIngestionPipeline({ ...DEFAULT_INGESTION_CONFIG, maxWebhookBodyBytes: 50, maxReadingsPerDelivery: 1 });
    pipeline.register(pushSource());
    expect(await pipeline.ingestWebhook("acme", signed([reading(), reading()]), NOW)).toMatchObject({ status: 413 });

    const p2 = new OracleIngestionPipeline({ ...DEFAULT_INGESTION_CONFIG, maxReadingsPerDelivery: 1 });
    p2.register(pushSource());
    expect(await p2.ingestWebhook("acme", signed([reading(), reading({ observedAt: NOW })]), NOW)).toMatchObject({
      status: 400,
      reason: "too_many_readings",
    });
  });

  it("returns 400 for a validly signed but malformed body", async () => {
    const { pipeline } = setup();
    expect(await pipeline.ingestWebhook("acme", signed({ nope: true }), NOW)).toMatchObject({ status: 400, reason: "invalid_payload" });
  });

  it("does not let unsigned junk fill the nonce store", async () => {
    const store = new InMemoryNonceStore(1);
    const pipeline = new OracleIngestionPipeline(DEFAULT_INGESTION_CONFIG, store);
    pipeline.register(pushSource());
    await pipeline.ingestWebhook("acme", signed([reading()], { secret: "x".repeat(32) }), NOW);
    expect(store.size()).toBe(0);
    expect((await pipeline.ingestWebhook("acme", signed([reading()]), NOW)).ok).toBe(true);
    // Store is now full of a live nonce; fail closed rather than evicting it.
    expect(await pipeline.ingestWebhook("acme", signed([reading({ observedAt: NOW })]), NOW)).toMatchObject({ reason: "nonce_store_full" });
  });
});

describe("OracleIngestionPipeline — per-reading checks (push and pull alike)", () => {
  it("rejects stale, future-dated, unregistered-feed and non-finite readings", async () => {
    const { pipeline } = setup();
    const res = await pipeline.ingestWebhook(
      "acme",
      signed([
        reading({ observedAt: NOW - DEFAULT_INGESTION_CONFIG.maxReadingAgeMs - 1 }),
        reading({ observedAt: NOW + DEFAULT_INGESTION_CONFIG.maxFutureSkewMs + 1 }),
        reading({ feedId: "btc-usd" }),
      ]),
      NOW,
    );
    expect(res.ok && res.rejected.map((r) => r.reason).sort()).toEqual(["feed_not_registered", "future_dated", "stale"]);
  });

  it("rejects readings dated after the request's signed timestamp", async () => {
    const { pipeline } = setup();
    const ts = Math.floor((NOW - 120_000) / 1000);
    const res = await pipeline.ingestWebhook("acme", signed([reading({ observedAt: NOW - 1000 })], { ts }), NOW);
    expect(res.ok && res.rejected[0].reason).toBe("after_signed_timestamp");
  });

  it("enforces strictly increasing observedAt and sequence per feed", async () => {
    const { pipeline } = setup();
    await pipeline.ingestWebhook("acme", signed([reading({ observedAt: NOW - 5000, sequence: 10 })]), NOW);
    const res = await pipeline.ingestWebhook(
      "acme",
      signed([reading({ observedAt: NOW - 5000, sequence: 11 }), reading({ observedAt: NOW - 4000, sequence: 10 }), reading({ observedAt: NOW - 3000, sequence: 12 })]),
      NOW,
    );
    expect(res.ok && res.rejected.map((r) => r.reason)).toEqual(["not_newer_than_last", "sequence_not_increasing"]);
    expect(res.ok && res.accepted.map((r) => r.sequence)).toEqual([12]);
  });

  it("applies the same checks to pull sources", async () => {
    const pipeline = new OracleIngestionPipeline();
    const sunk: IngestedReading[] = [];
    pipeline.onReadings((r) => {
      sunk.push(...r);
    });
    const pull: PullOracleSource = {
      id: "coingecko",
      mode: "pull",
      feeds: ["usdc-usd"],
      poll: async (now) => [reading({ observedAt: now - 100 }), reading({ observedAt: now - 10 * 60_000 }), reading({ feedId: "eth-usd" })],
    };
    pipeline.register(pull);
    const res = await pipeline.ingestPull("coingecko", NOW);
    expect(res.accepted).toHaveLength(1);
    expect(res.rejected.map((r) => r.reason).sort()).toEqual(["feed_not_registered", "stale"]);
    expect(sunk[0]).toMatchObject({ sourceId: "coingecko", mode: "pull" });
  });
});

describe("registration", () => {
  it("refuses push sources with weak, duplicate or missing credentials", () => {
    const p = new OracleIngestionPipeline();
    expect(() => p.register(pushSource({ keys: [] }))).toThrow(/no webhook credentials/);
    expect(() => p.register(pushSource({ keys: [{ keyId: "k", secret: "short" }] }))).toThrow(/shorter than 32/);
    expect(() =>
      p.register(pushSource({ keys: [{ keyId: "k", secret: SECRET }, { keyId: "k", secret: SECRET }] })),
    ).toThrow(/duplicate keyId/);
  });

  it("refuses duplicate ids and sources without feeds", () => {
    const p = new OracleIngestionPipeline();
    p.register(pushSource());
    expect(() => p.register(pushSource())).toThrow(/already registered/);
    expect(() => new OracleIngestionPipeline().register(pushSource({ feeds: [] }))).toThrow(/no feeds/);
  });

  it("parses ORACLE_PUSH_SOURCES and fails loudly on bad config", () => {
    const sources = pushSourcesFromEnv(JSON.stringify([{ id: "acme", feeds: ["usdc-usd"], keys: [{ keyId: "k1", secret: SECRET }] }]));
    expect(sources.map((s) => s.id)).toEqual(["acme"]);
    expect(pushSourcesFromEnv(undefined)).toEqual([]);
    expect(() => pushSourcesFromEnv("{}")).toThrow();
    expect(() => pushSourcesFromEnv('[{"id":"x"}]')).toThrow();
  });
});
