import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import request from "supertest";
import { runOracleOpsCli } from "./cli";
import { CONSENSUS_CONFIG, EVIDENCE_LEDGER, PAYLOAD_STORE } from "./consensus.config";
import { ConsensusModule } from "./consensus.module";
import { DecisionEvent } from "./evidence.types";
import { parseReconstructionQuery, reconstructConsensusState, serializeReconstruction } from "./reconstruction";
import { ConsensusHarness } from "./testing/fixtures";

const FEED = "StablecoinDepeg";

/** Small deterministic PRNG (mulberry32) so the property test is reproducible. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("reconstructConsensusState", () => {
  it("reproduces every live decision exactly across randomised histories (property)", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rand = rng(seed);
      const h = new ConsensusHarness();
      const sources = ["a", "b", "c", "d"];
      h.seedFeed(FEED, sources.slice(0, 3));
      const decisions: DecisionEvent[] = [];

      for (let step = 0; step < 60; step++) {
        const roll = rand();
        const src = sources[Math.floor(rand() * sources.length)];
        if (roll < 0.55) {
          if (src === "d" && !h.ledger.events().some((e) => e.kind === "source_version" && e.sourceId === "d")) continue;
          h.read(src, Math.round((0.85 + rand() * 0.2) * 1000) / 1000, {
            signature: rand() < 0.1 ? "failed" : "not_required",
            ledgerSeq: 1000 + step,
          });
        } else if (roll < 0.65) {
          h.consensus.registerSource({
            sourceId: src,
            providerId: src,
            feedId: FEED,
            weight: Math.round(rand() * 3 * 10) / 10,
            retentionDays: 30,
            status: rand() < 0.2 ? "quarantined" : "active",
          });
        } else if (roll < 0.7) {
          h.consensus.setQuorumPolicy({
            feedId: FEED,
            minSources: 1 + Math.floor(rand() * 3),
            minTotalWeight: Math.round(rand() * 2 * 10) / 10,
            maxReadingAgeMs: 60_000 + Math.floor(rand() * 300_000),
            trigger: { op: "lt", threshold: 0.9 + rand() * 0.1 },
          });
        } else if (roll < 0.85) {
          decisions.push(h.consensus.decide(FEED, 1000 + step));
        }
        h.advance(Math.floor(rand() * 90_000));
      }

      for (const d of decisions) {
        const state = reconstructConsensusState(h.ledger.events(), { feedId: FEED, at: d.at });
        expect(state.consistency).toBe("matches_recorded");
        expect(state.decision).toMatchObject({
          outcome: d.outcome,
          value: d.value,
          triggered: d.triggered,
          policyVersion: d.policyVersion,
          contributing: d.contributing,
        });
      }
    }
  });

  function scenario() {
    const h = new ConsensusHarness();
    h.seedFeed(FEED, ["coingecko", "kraken"], { expectedSources: 2 });
    h.read("coingecko", 0.9, { ledgerSeq: 100 });
    h.read("kraken", 0.92, { ledgerSeq: 101 });
    const first = h.consensus.decide(FEED, 101);
    h.advance(60_000);
    // Policy changes and a source joins only after the first decision.
    h.consensus.setQuorumPolicy({ feedId: FEED, minSources: 3, minTotalWeight: 3, maxReadingAgeMs: 300_000, trigger: { op: "lt", threshold: 0.95 } });
    h.consensus.registerSource({ sourceId: "binance", providerId: "binance", feedId: FEED, weight: 1, retentionDays: 30 });
    h.read("binance", 1.0, { ledgerSeq: 110 });
    h.read("coingecko", 1.0, { ledgerSeq: 111 });
    h.read("kraken", 1.0, { ledgerSeq: 112 });
    const second = h.consensus.decide(FEED, 112);
    return { h, first, second };
  }

  it("uses the policy and sources in force at T, not today's", () => {
    const { h, first } = scenario();
    const state = reconstructConsensusState(h.ledger.events(), { feedId: FEED, at: first.at });
    expect(state.quorumPolicy?.version).toBe(1);
    expect(state.sources.map((s) => s.sourceId)).toEqual(["coingecko", "kraken"]);
    expect(state.decision).toMatchObject({ outcome: "decision", triggered: true, value: 0.9 });
    expect(state.recordedDecision?.decisionId).toBe(first.decisionId);
    expect(state.consistency).toBe("matches_recorded");
  });

  it("between readings, reports the decision in force and recomputes from what was known", () => {
    const { h, first } = scenario();
    const mid = first.at + 30_000;
    const state = reconstructConsensusState(h.ledger.events(), { feedId: FEED, at: mid });
    expect(state.recordedDecision?.decisionId).toBe(first.decisionId);
    expect(state.consistency).toBe("no_decision_recorded_at_t");
    expect(state.decision.triggered).toBe(true);
  });

  it("shows a superseded decision as it stood at T, without leaking later facts", () => {
    const { h, first, second } = scenario();
    expect(second.triggered).toBe(false);
    const atFirst = serializeReconstruction(reconstructConsensusState(h.ledger.events(), { feedId: FEED, at: first.at }));
    expect(atFirst).not.toContain(second.decisionId);
    expect(atFirst).not.toContain("binance");
  });

  it("resolves a ledger sequence to the state when that ledger was last seen", () => {
    const { h, first, second } = scenario();
    const byLedger = reconstructConsensusState(h.ledger.events(), { feedId: FEED, ledgerSeq: 101 });
    expect(byLedger.resolvedAt).toBe(first.at);
    expect(byLedger.recordedDecision?.decisionId).toBe(first.decisionId);
    expect(reconstructConsensusState(h.ledger.events(), { feedId: FEED, ledgerSeq: 112 }).recordedDecision?.decisionId).toBe(second.decisionId);
    expect(reconstructConsensusState(h.ledger.events(), { feedId: FEED, ledgerSeq: 5 })).toMatchObject({
      resolvedAt: null,
      decision: { outcome: "no_decision", reason: "no_evidence_at_or_before_ledger_5" },
    });
  });

  it("explains no_decision for times before the feed existed or with no eligible sources", () => {
    const { h, first } = scenario();
    expect(reconstructConsensusState(h.ledger.events(), { feedId: FEED, at: 0 }).decision.reason).toBe("no_quorum_policy");

    const empty = new ConsensusHarness();
    empty.consensus.setQuorumPolicy({ feedId: FEED, minSources: 1, minTotalWeight: 0, maxReadingAgeMs: 1000, trigger: { op: "lt", threshold: 1 } });
    expect(reconstructConsensusState(empty.ledger.events(), { feedId: FEED, at: empty.ledger.now() }).decision.reason).toBe("no_sources_registered_at_t");

    const late = reconstructConsensusState(h.ledger.events(), { feedId: FEED, at: first.at + 10 * 60_000 });
    expect(late.decision.outcome).toBe("no_decision");
    expect(late.sources.every((s) => !s.eligible)).toBe(true);
  });

  it("is byte-identical when repeated, and unaffected by later ledger growth", () => {
    const { h, first } = scenario();
    const q = { feedId: FEED, at: first.at };
    const a = serializeReconstruction(reconstructConsensusState(h.ledger.events(), q));
    h.read("coingecko", 0.5);
    h.consensus.decide(FEED);
    const b = serializeReconstruction(reconstructConsensusState(h.ledger.events(), q));
    expect(b).toBe(a);
  });

  it("never mutates the ledger", () => {
    const { h, first } = scenario();
    const before = JSON.stringify(h.ledger.events());
    reconstructConsensusState(h.ledger.events(), { feedId: FEED, at: first.at });
    expect(JSON.stringify(h.ledger.events())).toBe(before);
  });

  it("validates queries identically for API and CLI", () => {
    expect(() => parseReconstructionQuery(FEED, {})).toThrow(/exactly one/);
    expect(() => parseReconstructionQuery(FEED, { at: "2026-01-01T00:00:00Z", ledger: "1" })).toThrow(/exactly one/);
    expect(() => parseReconstructionQuery(FEED, { at: "yesterday" })).toThrow(/ISO-8601/);
    expect(() => parseReconstructionQuery(FEED, { ledger: "-1" })).toThrow(/non-negative/);
    expect(() => parseReconstructionQuery("../etc", { ledger: "1" })).toThrow(/feed id/);
    expect(parseReconstructionQuery(FEED, { at: "2026-10-21T14:00:00.000Z" })).toEqual({ feedId: FEED, at: Date.parse("2026-10-21T14:00:00.000Z") });
  });
});

describe("reconstruction API and CLI", () => {
  let app: INestApplication;
  let dir: string;
  let ledgerPath: string;
  let h: ConsensusHarness;
  let decisionAtIso: string;
  const env = { ...process.env };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "recon-"));
    ledgerPath = path.join(dir, "evidence.jsonl");
    h = new ConsensusHarness({ ledgerPath });
    h.seedFeed(FEED, ["coingecko", "kraken"], { expectedSources: 2 });
    h.read("coingecko", 0.9, { ledgerSeq: 7 });
    h.read("kraken", 0.93, { ledgerSeq: 7 });
    decisionAtIso = new Date(h.consensus.decide(FEED, 7).at).toISOString();

    process.env.OPS_API_TOKEN = "ops-token";
    process.env.AUDITOR_API_TOKENS = "audit-1,audit-2";
    const moduleRef = await Test.createTestingModule({ imports: [ConsensusModule] })
      .overrideProvider(CONSENSUS_CONFIG)
      .useValue({ ledgerPath, holdReevaluateIntervalMs: 3_600_000, holdMaxDurationMs: 3_600_000 })
      .overrideProvider(EVIDENCE_LEDGER)
      .useValue(h.ledger)
      .overrideProvider(PAYLOAD_STORE)
      .useValue(h.payloads)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    process.env = env;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns byte-identical output from the API and the CLI", async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/ops/consensus/feeds/${FEED}/state`)
      .query({ at: decisionAtIso })
      .set("Authorization", "Bearer audit-2")
      .expect(200);
    const cli = runOracleOpsCli(["reconstruct", "--feed", FEED, "--at", decisionAtIso, "--ledger-file", ledgerPath]);
    expect(cli.exitCode).toBe(0);
    expect(res.text).toBe(cli.stdout);
    expect(JSON.parse(res.text).consistency).toBe("matches_recorded");

    const byLedger = await request(app.getHttpServer())
      .get(`/api/v1/ops/consensus/feeds/${FEED}/state?ledger=7`)
      .set("Authorization", "Bearer ops-token")
      .expect(200);
    expect(byLedger.text).toBe(runOracleOpsCli(["reconstruct", "--feed", FEED, "--ledger", "7", "--ledger-file", ledgerPath]).stdout);
  });

  it("enforces RBAC: no token → 401, auditor cannot write → 403", async () => {
    await request(app.getHttpServer()).get(`/api/v1/ops/consensus/feeds/${FEED}/state?ledger=7`).expect(401);
    await request(app.getHttpServer())
      .get(`/api/v1/ops/consensus/feeds/${FEED}/state?ledger=7`)
      .set("Authorization", "Bearer wrong")
      .expect(401);
    await request(app.getHttpServer())
      .post(`/api/v1/ops/consensus/feeds/${FEED}/decide`)
      .set("Authorization", "Bearer audit-1")
      .expect(403);
  });

  it("rejects malformed queries with 400", async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/ops/consensus/feeds/${FEED}/state?at=tomorrow`)
      .set("Authorization", "Bearer audit-1")
      .expect(400);
  });

  it("CLI reports errors with a non-zero exit code", () => {
    expect(runOracleOpsCli(["reconstruct", "--feed", FEED, "--ledger-file", ledgerPath])).toMatchObject({ exitCode: 1 });
    expect(runOracleOpsCli(["nope"])).toMatchObject({ exitCode: 1 });
  });
});
