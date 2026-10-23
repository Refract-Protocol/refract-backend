import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { computeConsensus } from "./consensus.engine";
import { assessEvidenceCompleteness } from "./evidence-completeness";
import { DecisionEvent } from "./evidence.types";
import { policyAt, readingsAt, sourcesAt } from "./ledger-view";
import { candidate, ConsensusHarness } from "./testing/fixtures";

describe("consensus engine", () => {
  it("takes the weighted median of eligible sources and applies the trigger rule", () => {
    const h = new ConsensusHarness();
    h.seedFeed();
    h.read("coingecko", 0.91);
    h.read("kraken", 0.92);
    h.read("binance", 0.99);
    const d = h.consensus.decide("StablecoinDepeg");
    expect(d.outcome).toBe("decision");
    expect(d.value).toBe(0.92);
    expect(d.triggered).toBe(true);
    expect(d.contributing).toHaveLength(3);
  });

  it("returns no_decision when quorum is not met", () => {
    const h = new ConsensusHarness();
    h.seedFeed();
    h.read("coingecko", 0.91);
    const d = h.consensus.decide("StablecoinDepeg");
    expect(d.outcome).toBe("no_decision");
    expect(d.reason).toMatch(/quorum_not_met/);
  });

  it("ignores readings older than the policy window and failed signatures", () => {
    const h = new ConsensusHarness();
    h.seedFeed();
    h.read("coingecko", 0.5);
    h.advance(10 * 60_000);
    h.read("kraken", 0.99);
    h.read("binance", 0.98, { signature: "failed" });
    const events = h.ledger.events();
    const now = h.ledger.now();
    const r = computeConsensus({
      feedId: "StablecoinDepeg",
      at: now,
      policy: policyAt(events, "StablecoinDepeg", now),
      sources: sourcesAt(events, "StablecoinDepeg", now),
      readings: readingsAt(events, "StablecoinDepeg", now),
    });
    const byId = Object.fromEntries(r.eligibility.map((e) => [e.sourceId, e.reason]));
    expect(byId).toEqual({ binance: "signature_failed", coingecko: "no_reading_in_window", kraken: null });
    expect(r.outcome).toBe("no_decision");
  });
});

describe("assessEvidenceCompleteness", () => {
  const setup = (mutate: (h: ConsensusHarness) => void): { h: ConsensusHarness; decision: DecisionEvent } => {
    const h = new ConsensusHarness();
    mutate(h);
    const decision = h.consensus.decide("StablecoinDepeg");
    expect(decision.triggered).toBe(true);
    return { h, decision };
  };
  const gapsOf = ({ h, decision }: { h: ConsensusHarness; decision: DecisionEvent }) =>
    assessEvidenceCompleteness(h.ledger.events(), decision, h.ledger.now(), (x) => h.payloads.has(x)).map((g) => g.type);

  it("reports nothing when evidence is complete", () => {
    expect(gapsOf(setup((h) => { h.seedFeed(); h.read("coingecko", 0.9); h.read("kraken", 0.9); h.read("binance", 0.9); }))).toEqual([]);
  });

  it("reports missing_raw_payload when capture failed", () => {
    expect(gapsOf(setup((h) => { h.seedFeed(); h.read("coingecko", 0.9, { payload: null }); h.read("kraken", 0.9); h.read("binance", 0.9); }))).toEqual(["missing_raw_payload"]);
  });

  it("reports missing_raw_payload when the body is gone from the store", () => {
    const ctx = setup((h) => { h.seedFeed(); h.read("coingecko", 0.9); h.read("kraken", 0.9); h.read("binance", 0.9); });
    const hash = ctx.h.ledger.events().find((e) => e.kind === "payload_stored")!;
    ctx.h.payloads.delete((hash as { hash: string }).hash);
    expect(gapsOf(ctx)).toEqual(["missing_raw_payload"]);
  });

  it("reports insufficient_sources when fewer sources contribute than expected", () => {
    expect(gapsOf(setup((h) => { h.seedFeed(); h.read("coingecko", 0.9); h.read("kraken", 0.9); }))).toEqual(["insufficient_sources"]);
  });

  it("reports source_in_warmup for an immature contributor", () => {
    expect(
      gapsOf(setup((h) => {
        h.seedFeed("StablecoinDepeg", ["coingecko", "kraken"]);
        h.consensus.registerSource({ sourceId: "newcomer", providerId: "n", feedId: "StablecoinDepeg", weight: 1, retentionDays: 30, warmupMs: 3_600_000 });
        h.consensus.setQuorumPolicy({ feedId: "StablecoinDepeg", minSources: 2, expectedSources: 3, minTotalWeight: 2, maxReadingAgeMs: 300_000, trigger: { op: "lt", threshold: 0.95 } });
        h.read("coingecko", 0.9); h.read("kraken", 0.9); h.read("newcomer", 0.9);
      })),
    ).toEqual(["source_in_warmup"]);
  });

  it("reports signature_pending for an unverified contributor", () => {
    expect(gapsOf(setup((h) => { h.seedFeed(); h.read("coingecko", 0.9, { signature: "pending" }); h.read("kraken", 0.9); h.read("binance", 0.9); }))).toEqual(["signature_pending"]);
  });
});

describe("ClaimHoldService", () => {
  it("passes ungoverned feeds through unchanged", () => {
    const h = new ConsensusHarness();
    expect(h.holds.gate(candidate("p", "FlightDelay"))).toEqual({ action: "proceed" });
  });

  it("proceeds without a hold when evidence is complete", () => {
    const h = new ConsensusHarness();
    h.seedFeed();
    h.read("coingecko", 0.9); h.read("kraken", 0.9); h.read("binance", 0.9);
    expect(h.holds.gate(candidate())).toEqual({ action: "proceed" });
    expect(h.holds.list()).toHaveLength(0);
  });

  it("places a hold with gaps, writes an audit entry, and is idempotent across re-scans", () => {
    const h = new ConsensusHarness();
    h.seedFeed();
    h.read("coingecko", 0.9, { signature: "pending" }); h.read("kraken", 0.9); h.read("binance", 0.9);

    const first = h.holds.gate(candidate());
    const second = h.holds.gate(candidate());
    expect(first.action).toBe("block");
    expect(second).toEqual(first);
    const holds = h.holds.list();
    expect(holds).toHaveLength(1);
    expect(holds[0].status).toBe("payout_held");
    expect(holds[0].gaps.map((g) => g.type)).toEqual(["signature_pending"]);
    expect(holds[0].reason).toMatch(/signature_pending/);
    expect(h.ledger.events().filter((e) => e.kind === "audit" && e.action === "claim_hold.placed")).toHaveLength(1);
  });

  it("releases automatically when the pending signature verifies, then settles", () => {
    const h = new ConsensusHarness();
    h.seedFeed();
    const pending = h.read("coingecko", 0.9, { signature: "pending" });
    h.read("kraken", 0.9); h.read("binance", 0.9);
    h.holds.gate(candidate());

    expect(h.holds.reevaluateAll()).toEqual({ released: 0, escalated: 0, stillHeld: 1 });
    h.consensus.recordSignatureResult(pending.readingId, "verified");
    expect(h.holds.reevaluateAll()).toEqual({ released: 1, escalated: 0, stillHeld: 0 });

    const gate = h.holds.gate(candidate());
    expect(gate.action).toBe("proceed");
    h.holds.markSettled((gate as { holdId: string }).holdId);
    expect(h.holds.list()[0].status).toBe("settled");
    expect(h.ledger.events().some((e) => e.kind === "audit" && e.action === "claim_hold.released")).toBe(true);
  });

  it("releases when a dropped-out source reports again within the window", () => {
    const h = new ConsensusHarness();
    h.seedFeed();
    h.read("coingecko", 0.9); h.read("kraken", 0.9);
    h.holds.gate(candidate());
    expect(h.holds.list()[0].gaps.map((g) => g.type)).toEqual(["insufficient_sources"]);

    h.read("binance", 0.91);
    expect(h.holds.reevaluateAll().released).toBe(1);
  });

  it("does not spam the ledger when re-evaluation finds nothing new", () => {
    const h = new ConsensusHarness();
    h.seedFeed();
    h.read("coingecko", 0.9, { payload: null }); h.read("kraken", 0.9); h.read("binance", 0.9);
    h.holds.gate(candidate());
    h.holds.reevaluateAll();
    h.holds.reevaluateAll();
    expect(h.ledger.events().filter((e) => e.kind === "hold_reevaluated")).toHaveLength(0);
  });

  it("escalates at the deadline and requires an operator disposition", () => {
    const h = new ConsensusHarness();
    h.seedFeed();
    h.read("coingecko", 0.9, { payload: null }); h.read("kraken", 0.9); h.read("binance", 0.9);
    h.holds.gate(candidate());

    h.advance(h.config.holdMaxDurationMs + 60_000);
    expect(h.holds.reevaluateAll().escalated).toBe(1);
    const [hold] = h.holds.list("escalated");
    expect(hold.escalation).toBe("deadline_exceeded");
    expect(h.holds.gate(candidate()).action).toBe("block");

    expect(() => h.holds.dispose(hold.holdId, "approve_payout", "", "")).toThrow(/actor and note/);
    h.holds.dispose(hold.holdId, "approve_payout", "ops@refract", "payload recovered from provider archive");
    expect(h.holds.gate(candidate())).toEqual({ action: "proceed", holdId: hold.holdId });
  });

  it("extend_hold returns the claim to the held queue with a new deadline", () => {
    const h = new ConsensusHarness();
    h.seedFeed();
    h.read("coingecko", 0.9, { payload: null }); h.read("kraken", 0.9); h.read("binance", 0.9);
    h.holds.gate(candidate());
    h.advance(h.config.holdMaxDurationMs + 60_000);
    h.holds.reevaluateAll();
    const [hold] = h.holds.list("escalated");
    const after = h.holds.dispose(hold.holdId, "extend_hold", "ops", "waiting on provider", 60_000);
    expect(after.status).toBe("payout_held");
    expect(after.deadline).toBeGreaterThanOrEqual(h.nowMs + 60_000);
    expect(after.escalation).toBeNull();
  });

  it("deny blocks the payout permanently for that policy", () => {
    const h = new ConsensusHarness();
    h.seedFeed();
    h.read("coingecko", 0.9, { payload: null }); h.read("kraken", 0.9); h.read("binance", 0.9);
    const gate = h.holds.gate(candidate()) as { holdId: string };
    h.holds.dispose(gate.holdId, "deny", "ops", "fraudulent upstream");
    expect(h.holds.gate(candidate())).toMatchObject({ action: "block", reason: expect.stringMatching(/denied/) });
  });

  it("escalates when new evidence contradicts the verdict instead of auto-denying", () => {
    const h = new ConsensusHarness();
    h.seedFeed();
    h.read("coingecko", 0.9, { payload: null }); h.read("kraken", 0.9); h.read("binance", 0.9);
    h.holds.gate(candidate());
    h.read("coingecko", 1.0); h.read("kraken", 1.0); h.read("binance", 1.0);
    expect(h.holds.reevaluateAll().escalated).toBe(1);
    expect(h.holds.list()[0]).toMatchObject({ status: "escalated", escalation: "verdict_contradicted" });
  });

  it("escalates a claim whose policy expired while held", () => {
    const h = new ConsensusHarness({ config: { holdMaxDurationMs: 10 * 86_400_000 } });
    h.seedFeed();
    h.read("coingecko", 0.9, { payload: null }); h.read("kraken", 0.9); h.read("binance", 0.9);
    h.holds.gate(candidate("pol-1", "StablecoinDepeg", 60_000, h.nowMs));
    h.advance(120_000);
    h.holds.reevaluateAll();
    expect(h.holds.list()[0].escalation).toBe("policy_expired_while_held");
  });

  it("fails closed when the evidence ledger cannot be written", () => {
    const h = new ConsensusHarness();
    h.seedFeed();
    h.read("coingecko", 0.9, { payload: null }); h.read("kraken", 0.9); h.read("binance", 0.9);
    jest.spyOn(h.ledger, "append").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(h.holds.gate(candidate())).toMatchObject({ action: "block", reason: expect.stringMatching(/disk full/) });
  });

  it("rebuilds the hold queue from the persisted ledger after a restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
    const ledgerPath = path.join(dir, "evidence.jsonl");
    const h = new ConsensusHarness({ ledgerPath, payloadDir: path.join(dir, "payloads") });
    h.seedFeed();
    h.read("coingecko", 0.9, { payload: null }); h.read("kraken", 0.9); h.read("binance", 0.9);
    h.holds.gate(candidate());

    const restarted = new ConsensusHarness({ ledgerPath, payloadDir: path.join(dir, "payloads") });
    expect(restarted.holds.list()).toEqual(h.holds.list());
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
