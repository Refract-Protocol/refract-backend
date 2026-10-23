import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { HistoricalSample } from "../bootstrap/baseline";
import { HistoryProviderRegistry } from "../bootstrap/history-providers";
import { OracleAdminModule } from "./oracle-admin.module";
import { OracleAuditLog } from "./oracle-audit";
import { generateOperatorKey } from "./operator-identity";

const viewer = generateOperatorKey("viewer-1", "vic", "oracle:viewer");
const operator = generateOperatorKey("operator-1", "olga", "oracle:operator");
const admin = generateOperatorKey("admin-1", "ada", "oracle:admin");
const admin2 = generateOperatorKey("admin-2", "ada", "oracle:admin");

const feedsConfig = {
  version: 1,
  defaults: { trustMode: "median_quorum" },
  feeds: [
    {
      id: "depeg",
      coverageType: "StablecoinDepeg",
      quorum: { minSources: 2 },
      sources: [
        { id: "a", adapter: "coingecko", operator: "coingecko", params: { coinId: "usd-coin" } },
        { id: "b", adapter: "horizon", operator: "sdex" },
        { id: "c", adapter: "defillama", operator: "llama", params: { coinId: "usd-coin" } },
      ],
    },
  ],
};

function hourly(base: number): HistoricalSample[] {
  const now = Date.now();
  return Array.from({ length: 72 }, (_, i) => ({ timestamp: now - (72 - i) * 3_600_000, value: base }));
}

describe("Oracle operator endpoints (HTTP)", () => {
  let app: INestApplication;
  const savedEnv = { ...process.env };
  const fetchHistory = jest.fn(async () => hourly(1));

  beforeAll(async () => {
    process.env = {
      ...savedEnv,
      ORACLE_OPERATOR_KEYS: JSON.stringify([viewer, operator, admin, admin2].map((k) => k.credential)),
      ORACLE_FEEDS_JSON: JSON.stringify(feedsConfig),
      ORACLE_BOOTSTRAP_ON_STARTUP: "false",
      ORACLE_OPERATOR_WRITE_LIMIT_PER_MIN: "6",
      ORACLE_OPERATOR_AUTH_FAILURE_LIMIT: "3",
      STELLAR_NETWORK: "testnet",
    };
    delete process.env.DATABASE_URL;
    delete process.env.SANDBOX_MODE;

    const moduleRef = await Test.createTestingModule({ imports: [OracleAdminModule] })
      .overrideProvider(HistoryProviderRegistry)
      .useValue(new HistoryProviderRegistry([{ adapter: "coingecko", fetchHistory }]))
      .overrideProvider(OracleAuditLog)
      .useValue(new OracleAuditLog({ write: () => undefined }))
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    process.env = savedEnv;
  });

  const http = () => request(app.getHttpServer());
  const bearer = (key: { token: string }) => ({ Authorization: `Bearer ${key.token}` });
  const audit = () => app.get(OracleAuditLog).list(1_000);

  it("rejects requests without valid credentials with a generic 401 and audits the reason", async () => {
    const res = await http().get("/api/v1/oracle/admin/feeds").set("X-Request-Id", "req-anon-1");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("OPERATOR_AUTH_REQUIRED");

    const bad = await http()
      .get("/api/v1/oracle/admin/feeds")
      .set("Authorization", "Bearer admin-1.wrongwrongwrongwrongwrong");
    expect(bad.status).toBe(401);
    expect(JSON.stringify(bad.body)).not.toMatch(/invalid_secret|admin-1/);

    const events = audit();
    expect(events.find((e) => e.requestId === "req-anon-1")).toMatchObject({
      outcome: "denied",
      reason: "missing_credentials",
      actor: { id: "anonymous" },
      statusCode: 401,
    });
    expect(events.some((e) => e.reason === "invalid_secret:admin-1")).toBe(true);
  });

  it("lets every role read feeds and identifies the caller", async () => {
    const res = await http().get("/api/v1/oracle/admin/whoami").set(bearer(viewer));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ actor: "vic", role: "oracle:viewer", keyId: "viewer-1" });

    const feeds = await http().get("/api/v1/oracle/admin/feeds").set(bearer(viewer));
    expect(feeds.status).toBe(200);
    expect(feeds.body.feeds[0].definition.id).toBe("depeg");
    expect(feeds.headers["x-ratelimit-limit"]).toBe("120");
  });

  it("enforces role permissions on every mutating control", async () => {
    const cases: Array<[string, string, object]> = [
      ["put", "/api/v1/oracle/admin/feeds/depeg/quorum", { minSources: 2 }],
      ["put", "/api/v1/oracle/admin/feeds/depeg/override", { value: 1, reason: "test", expiresAt: new Date(Date.now() + 60_000).toISOString() }],
      ["put", "/api/v1/oracle/admin/feeds/depeg/sources/a/quarantine", { action: "release", reason: "test" }],
      ["put", "/api/v1/oracle/admin/feeds/depeg", feedsConfig.feeds[0]],
      ["get", "/api/v1/oracle/admin/audit", {}],
    ];
    for (const [method, path, body] of cases) {
      const res = await (http() as unknown as Record<string, (p: string) => request.Test>)
        [method](path)
        .set(bearer(operator))
        .send(body);
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }

    const viewerPause = await http()
      .post("/api/v1/oracle/admin/feeds/depeg/pause")
      .set(bearer(viewer))
      .send({ reason: "nope" });
    expect(viewerPause.status).toBe(403);
    expect(audit().some((e) => e.reason === "missing_permission:feeds:pause" && e.actor.id === "vic")).toBe(true);
  });

  it("lets operators pause and resume, propagating their identity into state and audit", async () => {
    const res = await http()
      .post("/api/v1/oracle/admin/feeds/depeg/pause")
      .set(bearer(operator))
      .set("X-Request-Id", "pause-1")
      .send({ reason: "CoinGecko incident" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ paused: true, by: "olga", reason: "CoinGecko incident" });
    expect(res.headers["x-request-id"]).toBe("pause-1");

    const event = audit().find((e) => e.requestId === "pause-1");
    expect(event).toMatchObject({
      action: "feeds.pause",
      outcome: "success",
      actor: { id: "olga", role: "oracle:operator", keyId: "operator-1" },
      target: { feedId: "depeg" },
    });
    expect(event?.changes[0]).toMatchObject({ entity: "pause", id: "depeg", after: { paused: true, by: "olga" } });

    const resumed = await http().post("/api/v1/oracle/admin/feeds/depeg/resume").set(bearer(operator)).send({});
    expect(resumed.body).toMatchObject({ paused: false, by: "olga" });
  });

  it("validates bodies and rejects unsafe quorum edits with the validator's issues", async () => {
    const missingReason = await http().post("/api/v1/oracle/admin/feeds/depeg/pause").set(bearer(admin)).send({});
    expect(missingReason.status).toBe(400);

    const unsafe = await http()
      .put("/api/v1/oracle/admin/feeds/depeg/quorum")
      .set(bearer(admin))
      .send({ minSources: 4 });
    expect(unsafe.status).toBe(422);
    expect(unsafe.body.issues.map((i: { code: string }) => i.code)).toContain("QUORUM_EXCEEDS_INDEPENDENT_SOURCES");
    expect(audit()[0]).toMatchObject({
      action: "quorum.update",
      outcome: "failure",
      statusCode: 422,
      reason: expect.stringContaining("QUORUM_EXCEEDS_INDEPENDENT_SOURCES"),
    });

    const ok = await http()
      .put("/api/v1/oracle/admin/feeds/depeg/quorum")
      .set(bearer(admin))
      .send({ minSources: 2, maxDeviationBps: 50, expectedRevision: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body.value).toMatchObject({ revision: 2, updatedBy: "ada" });

    const stale = await http()
      .put("/api/v1/oracle/admin/feeds/depeg/quorum")
      .set(bearer(admin))
      .send({ minSources: 2, expectedRevision: 1 });
    expect(stale.status).toBe(409);
  });

  it("bootstraps sources added through the API as the acting operator", async () => {
    const feed = {
      id: "crash",
      coverageType: "MarketCrash",
      quorum: { minSources: 2 },
      sources: [
        { id: "x", adapter: "coingecko", operator: "coingecko", params: { coinId: "stellar" } },
        { id: "y", adapter: "coingecko", operator: "cg-mirror", params: { coinId: "stellar" } },
      ],
    };
    const res = await http().put("/api/v1/oracle/admin/feeds/crash").set(bearer(admin)).send(feed);
    expect(res.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const records = await http().get("/api/v1/oracle/admin/bootstrap?feedId=crash").set(bearer(viewer));
    expect(records.body.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: "x", status: "warm", requestedBy: "ada" }),
        expect.objectContaining({ sourceId: "y", status: "warm", requestedBy: "ada" }),
      ])
    );
  });

  it("lets operators re-run a source bootstrap", async () => {
    const res = await http()
      .post("/api/v1/oracle/admin/feeds/depeg/sources/a/bootstrap")
      .set(bearer(operator))
      .send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sourceId: "a", status: "warm" });
  });

  it("rate limits mutations per actor across all of that actor's keys", async () => {
    // "ada" holds admin-1 and admin-2; they share one write budget of 6 per minute,
    // part of which earlier tests already used.
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const key = i % 2 === 0 ? admin : admin2;
      const res = await http()
        .post("/api/v1/oracle/admin/feeds/depeg/pause")
        .set(bearer(key))
        .send({ reason: `drill ${i}` });
      statuses.push(res.status);
      if (res.status === 429) {
        expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
      }
    }
    expect(statuses).toContain(429);
    expect(audit().some((e) => e.reason === "rate_limited:write" && e.actor.id === "ada")).toBe(true);

    // Another actor's budget is unaffected.
    const other = await http().post("/api/v1/oracle/admin/feeds/depeg/resume").set(bearer(operator)).send({});
    expect(other.status).toBe(200);
  });

  it("locks out an IP after repeated failed authentication, even for a valid key", async () => {
    // Earlier tests used part of this IP's failure budget of 3.
    for (let i = 0; i < 3; i++) {
      await http().get("/api/v1/oracle/admin/feeds").set("Authorization", "Bearer nobody.AAAAAAAAAAAAAAAAAAAAAAAA");
    }
    const locked = await http().get("/api/v1/oracle/admin/feeds").set(bearer(viewer));
    expect(locked.status).toBe(429);
    expect(audit()[0]).toMatchObject({ reason: "auth_failure_lockout", outcome: "denied" });
  });
});

describe("Oracle operator endpoints without configured keys", () => {
  it("refuse every request with 503", async () => {
    const savedEnv = { ...process.env };
    process.env = { ...savedEnv, ORACLE_BOOTSTRAP_ON_STARTUP: "false" };
    delete process.env.ORACLE_OPERATOR_KEYS;
    delete process.env.ORACLE_FEEDS_JSON;
    delete process.env.ORACLE_FEEDS_FILE;
    delete process.env.DATABASE_URL;

    const moduleRef = await Test.createTestingModule({ imports: [OracleAdminModule] })
      .overrideProvider(OracleAuditLog)
      .useValue(new OracleAuditLog({ write: () => undefined }))
      .compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    try {
      const res = await request(app.getHttpServer()).get("/api/v1/oracle/admin/feeds");
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("OPERATOR_AUTH_NOT_CONFIGURED");
    } finally {
      await app.close();
      process.env = savedEnv;
    }
  });
});
