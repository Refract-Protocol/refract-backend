import { QuorumVerdict } from "../../oracle/regions/region-quorum";
import { TrustTransition } from "../../oracle/regions/regional-quorum.aggregator";
import { TriggerStabilityConfig } from "../trigger/trigger-stability";
import { AdjudicationRecord, feedIdForPolicy } from "./adjudication";
import { TrustedReading, planReevaluation } from "./reevaluation-planner";
import { AdjudicationLedger, DEFAULT_REEVALUATION_CONFIG, FeedStillUntrustedError, ReevaluationService, ReevaluationSettlementExecutor, TrustedReadingHistory } from "./reevaluation.service";

const MIN = 60_000;
const T0 = 1_760_000_000_000;
const FEED = "usdc-usd";

// Simple debounce for readability: 2 observations over >= 2 minutes, 0.005 band.
const TRIGGER: TriggerStabilityConfig = {
  hysteresis: 0.005,
  minDwellMs: 2 * MIN,
  minConfirmations: 2,
  flap: { penaltyPerFlip: 1000, suppressAbove: 3000, reuseBelow: 750, halfLifeMs: 15 * MIN, maxPenalty: 6000 },
};
const CONFIG = { ...DEFAULT_REEVALUATION_CONFIG, lookbackMs: 15 * MIN, confirmWindowMs: 30 * MIN, triggerConfigFor: () => TRIGGER };

function rec(overrides: Partial<AdjudicationRecord> & Pick<AdjudicationRecord, "policyId" | "outcome" | "decidedAt">): AdjudicationRecord {
  return {
    id: `${overrides.policyId}:${overrides.decidedAt}`,
    holder: `G-${overrides.policyId}`,
    coverageType: 0,
    feedId: FEED,
    trustState: "degraded",
    readingValue: 0.94,
    threshold: 0.95,
    direction: "below",
    coverageAmount: "1000000000",
    paid: overrides.outcome === "settled" ? "1000000000" : "0",
    expiresAt: T0 + 30 * 24 * 60 * MIN,
    ...overrides,
  };
}

function readings(series: Array<[number, number]>, provenance: TrustedReading["provenance"] = "quorum"): TrustedReading[] {
  return series.map(([minute, value]) => ({ observedAt: T0 + minute * MIN, value, provenance }));
}

const depegged = readings([[-10, 0.94], [-5, 0.93], [0, 0.93], [5, 0.92], [60, 0.93], [65, 0.93]]);
const healthy = readings([[-10, 0.999], [-5, 0.999], [0, 1.0], [60, 0.999], [65, 1.0]]);

function plan(records: AdjudicationRecord[], trusted: TrustedReading[], paid: string[] = []) {
  return planReevaluation({
    feedId: FEED,
    degradedSince: T0,
    restoredAt: T0 + 60 * MIN,
    records,
    trustedReadings: trusted,
    triggerConfigFor: () => TRIGGER,
    alreadyPaidPolicies: new Set(paid),
    lookbackMs: CONFIG.lookbackMs,
    confirmWindowMs: CONFIG.confirmWindowMs,
  });
}

describe("planReevaluation", () => {
  it("settles a held claim when trusted data confirms the trigger", () => {
    const p = plan([rec({ policyId: "p1", outcome: "held", decidedAt: T0 + 10 * MIN })], depegged);
    expect(p.items[0]).toMatchObject({ before: "held", after: "triggered", action: "settle", changed: true, payoutDelta: "1000000000" });
    expect(p.items[0].evidence.triggerConfirmedAt).not.toBeNull();
  });

  it("releases a held claim when trusted data shows no trigger", () => {
    const p = plan([rec({ policyId: "p1", outcome: "held", decidedAt: T0 + 10 * MIN })], healthy);
    expect(p.items[0]).toMatchObject({ after: "not_triggered", action: "release", changed: true, payoutDelta: "0" });
  });

  it("settles a skipped claim the untrusted feed missed", () => {
    const p = plan([rec({ policyId: "p1", outcome: "skipped", decidedAt: T0 + 10 * MIN, readingValue: 1.0 })], depegged);
    expect(p.items[0].action).toBe("settle");
  });

  it("leaves a skipped claim alone when trusted data agrees", () => {
    const p = plan([rec({ policyId: "p1", outcome: "skipped", decidedAt: T0 + 10 * MIN })], healthy);
    expect(p.items[0]).toMatchObject({ action: "no_change", changed: false });
  });

  it("flags a settlement the trusted data doesn't support, with a negative delta, and confirms one it does", () => {
    const flagged = plan([rec({ policyId: "p1", outcome: "settled", decidedAt: T0 + 10 * MIN })], healthy);
    expect(flagged.items[0]).toMatchObject({ action: "flag_overpayment", payoutDelta: "-1000000000" });
    const ok = plan([rec({ policyId: "p1", outcome: "settled", decidedAt: T0 + 10 * MIN })], depegged);
    expect(ok.items[0]).toMatchObject({ action: "no_change" });
  });

  it("needs manual review when there's no trusted data in the window", () => {
    const p = plan([rec({ policyId: "p1", outcome: "held", decidedAt: T0 + 10 * MIN })], readings([[-500, 0.9]]));
    expect(p.items[0]).toMatchObject({ after: "insufficient_data", action: "manual_review" });
  });

  it("never pays a policy twice: later records and already-paid policies are superseded", () => {
    const p = plan(
      [
        rec({ policyId: "p1", outcome: "held", decidedAt: T0 + 10 * MIN }),
        rec({ policyId: "p1", outcome: "skipped", decidedAt: T0 + 20 * MIN }),
        rec({ policyId: "p2", outcome: "held", decidedAt: T0 + 10 * MIN }),
        rec({ policyId: "p3", outcome: "held", decidedAt: T0 + 5 * MIN }),
        rec({ policyId: "p3", outcome: "settled", decidedAt: T0 + 30 * MIN }),
      ],
      depegged,
      ["p2"],
    );
    const byRecord = Object.fromEntries(p.items.map((i) => [i.recordId, i.action]));
    expect(byRecord[`p1:${T0 + 10 * MIN}`]).toBe("settle");
    expect(byRecord[`p1:${T0 + 20 * MIN}`]).toBe("superseded");
    expect(byRecord[`p2:${T0 + 10 * MIN}`]).toBe("superseded");
    expect(byRecord[`p3:${T0 + 5 * MIN}`]).toBe("superseded");
    expect(p.summary.settle).toBe(1);
    expect(p.summary.netPayoutDelta).toBe("1000000000");
  });

  it("ignores readings after the policy expired", () => {
    const p = plan([rec({ policyId: "p1", outcome: "held", decidedAt: T0 - 2 * MIN, expiresAt: T0 - MIN })], readings([[-12, 0.999], [-1, 0.999], [0, 0.9], [5, 0.9]]));
    expect(p.items[0].after).toBe("not_triggered");
  });

  it("uses the same debounce as live scans: a one-off dip doesn't trigger", () => {
    const p = plan([rec({ policyId: "p1", outcome: "held", decidedAt: T0 })], readings([[-10, 0.999], [0, 0.94], [1, 0.999], [60, 0.999]]));
    expect(p.items[0].after).toBe("not_triggered");
  });

  it("is deterministic: same inputs give the same run id and items regardless of input order", () => {
    const records = [rec({ policyId: "b", outcome: "held", decidedAt: T0 + 10 * MIN }), rec({ policyId: "a", outcome: "held", decidedAt: T0 + 10 * MIN })];
    const a = plan(records, depegged);
    const b = plan([...records].reverse(), [...depegged].reverse());
    expect(a).toEqual(b);
    expect(a.items.map((i) => i.policyId)).toEqual(["a", "b"]);
    expect(plan(records, healthy).runId).not.toBe(a.runId);
  });

  it("records the provenance of the evidence", () => {
    const p = plan([rec({ policyId: "p1", outcome: "held", decidedAt: T0 })], [...healthy, ...readings([[2, 0.9]], "operator_backfill")]);
    expect(p.items[0].evidence.provenance).toEqual(["operator_backfill", "quorum"]);
  });
});

describe("AdjudicationLedger", () => {
  it("collapses repeated identical decisions for a policy into one record", () => {
    const l = new AdjudicationLedger();
    expect(l.record(rec({ policyId: "p1", outcome: "held", decidedAt: T0 }))).toBe(true);
    expect(l.record(rec({ policyId: "p1", outcome: "held", decidedAt: T0 + MIN }))).toBe(false);
    expect(l.record(rec({ policyId: "p1", outcome: "skipped", decidedAt: T0 + 2 * MIN }))).toBe(true);
    expect(l.pending(FEED).map((r) => r.outcome)).toEqual(["held", "skipped"]);
  });

  it("tracks settled policies as paid", () => {
    const l = new AdjudicationLedger();
    l.record(rec({ policyId: "p1", outcome: "settled", decidedAt: T0 }));
    expect(l.isPaid("p1")).toBe(true);
  });
});

describe("ReevaluationService", () => {
  const verdict = (minute: number, value: number): QuorumVerdict => ({
    feedId: FEED,
    trust: "trusted",
    value,
    agreeingRegions: ["a", "b"],
    dissentingRegions: [],
    failingRegions: [],
    missingRegions: [],
    correlatedFailures: [],
    reasons: [],
    evaluatedAt: T0 + minute * MIN,
  });
  const transition = (minute: number, from: TrustTransition["from"], to: TrustTransition["to"]): TrustTransition => ({
    feedId: FEED,
    from,
    to,
    at: T0 + minute * MIN,
    verdict: { ...verdict(minute, 0), trust: to, value: null },
  });

  function scenario(settle: ReevaluationSettlementExecutor["settle"]) {
    const svc = new ReevaluationService(new AdjudicationLedger(), new TrustedReadingHistory(), CONFIG);
    // Trusted depeg readings before the outage, outage at minute 0, restore at minute 60.
    [[-10, 0.94], [-5, 0.93]].forEach(([m, v]) => svc.onVerdict(verdict(m, v)));
    svc.onTrustTransition(transition(0, "trusted", "degraded"));
    svc.ledger.record(rec({ policyId: "p1", outcome: "held", decidedAt: T0 + 10 * MIN }));
    svc.ledger.record(rec({ policyId: "p2", outcome: "settled", decidedAt: T0 + 10 * MIN, trustState: "under_corroborated" }));
    [[60, 0.93], [65, 0.93]].forEach(([m, v]) => svc.onVerdict(verdict(m, v)));
    const executor: ReevaluationSettlementExecutor = { settle: jest.fn(settle) };
    return { svc, executor };
  }

  it("plans a run automatically when trust is restored, and only once", () => {
    const { svc } = scenario(async () => ({ settled: true, txHash: "tx" }));
    const run = svc.onTrustTransition(transition(60, "degraded", "trusted"))!;
    expect(run.status).toBe("planned");
    expect(run.items.map((i) => [i.policyId, i.action])).toEqual([
      ["p1", "settle"],
      ["p2", "no_change"],
    ]);
    expect(svc.onTrustTransition(transition(61, "trusted", "trusted"))).toBeUndefined();
    expect(svc.listRuns()).toHaveLength(1);
  });

  it("does nothing on the first trusted verdict when nothing was degraded", () => {
    const svc = new ReevaluationService(new AdjudicationLedger(), new TrustedReadingHistory(), CONFIG);
    expect(svc.onTrustTransition(transition(0, null, "trusted"))).toBeUndefined();
  });

  it("applies settle actions, records tx hashes, and is idempotent on re-apply", async () => {
    const { svc, executor } = scenario(async () => ({ settled: true, txHash: "tx-p1" }));
    const run = svc.onTrustTransition(transition(60, "degraded", "trusted"))!;
    const applied = await svc.apply(run.runId, executor, "ops-alice", T0 + 70 * MIN);
    expect(applied.status).toBe("applied");
    expect(applied.itemStatus[`p1:${T0 + 10 * MIN}`]).toEqual({ status: "done", txHash: "tx-p1" });
    await svc.apply(run.runId, executor, "ops-alice", T0 + 71 * MIN);
    expect(executor.settle).toHaveBeenCalledTimes(1);
    expect(svc.ledger.isPaid("p1")).toBe(true);
  });

  it("retries failed settlements on the next apply", async () => {
    let attempts = 0;
    const { svc, executor } = scenario(async () => (++attempts === 1 ? { settled: false, error: "rpc down" } : { settled: true, txHash: "tx" }));
    const run = svc.onTrustTransition(transition(60, "degraded", "trusted"))!;
    expect((await svc.apply(run.runId, executor, "ops", T0)).status).toBe("partially_applied");
    expect(run.itemStatus[`p1:${T0 + 10 * MIN}`]).toMatchObject({ status: "failed", error: "rpc down" });
    expect((await svc.apply(run.runId, executor, "ops", T0)).status).toBe("applied");
    expect(executor.settle).toHaveBeenCalledTimes(2);
  });

  it("skips a settle if the policy got paid elsewhere after planning", async () => {
    const { svc, executor } = scenario(async () => ({ settled: true }));
    const run = svc.onTrustTransition(transition(60, "degraded", "trusted"))!;
    svc.ledger.markPaid("p1");
    await svc.apply(run.runId, executor, "ops", T0);
    expect(executor.settle).not.toHaveBeenCalled();
    expect(run.itemStatus[`p1:${T0 + 10 * MIN}`].error).toMatch(/already paid/);
  });

  it("supports a manual plan with operator backfill when quorum data has a gap", () => {
    const svc = new ReevaluationService(new AdjudicationLedger(), new TrustedReadingHistory(), CONFIG);
    svc.ledger.record(rec({ policyId: "p1", outcome: "held", decidedAt: T0 + 10 * MIN }));
    const run = svc.plan(FEED, T0 + 60 * MIN, T0 + 60 * MIN, [
      { observedAt: T0 + 9 * MIN, value: 0.93 },
      { observedAt: T0 + 12 * MIN, value: 0.93 },
    ])!;
    expect(run.items[0]).toMatchObject({ action: "settle" });
    expect(run.items[0].evidence.provenance).toEqual(["operator_backfill"]);
  });

  it("refuses to plan manually while the feed is still untrusted", () => {
    const svc = new ReevaluationService(new AdjudicationLedger(), new TrustedReadingHistory(), CONFIG);
    svc.onTrustTransition(transition(0, "trusted", "degraded"));
    svc.ledger.record(rec({ policyId: "p1", outcome: "held", decidedAt: T0 + 10 * MIN }));
    expect(() => svc.plan(FEED, T0 + 20 * MIN, T0 + 20 * MIN)).toThrow(FeedStillUntrustedError);
  });

  it("applies in bounded batches and continues on the next call", async () => {
    const svc = new ReevaluationService(new AdjudicationLedger(), new TrustedReadingHistory(), CONFIG);
    for (let i = 0; i < 5; i++) svc.ledger.record(rec({ policyId: `p${i}`, outcome: "held", decidedAt: T0 + 10 * MIN }));
    const run = svc.plan(FEED, T0 + 60 * MIN, T0 + 60 * MIN, [
      { observedAt: T0 + 9 * MIN, value: 0.93 },
      { observedAt: T0 + 12 * MIN, value: 0.93 },
    ])!;
    const executor: ReevaluationSettlementExecutor = { settle: jest.fn(async () => ({ settled: true, txHash: "tx" })) };
    expect((await svc.apply(run.runId, executor, "ops", T0, 2)).status).toBe("partially_applied");
    expect(executor.settle).toHaveBeenCalledTimes(2);
    await svc.apply(run.runId, executor, "ops", T0, 2);
    expect((await svc.apply(run.runId, executor, "ops", T0, 2)).status).toBe("applied");
    expect(executor.settle).toHaveBeenCalledTimes(5);
    await expect(svc.apply(run.runId, executor, "ops", T0, 0)).rejects.toThrow(/maxItems/);
  });

  it("records reversal approvals for flagged overpayments in an append-only audit trail, never reversing automatically", async () => {
    const executor: ReevaluationSettlementExecutor = { settle: jest.fn(async () => ({ settled: true })) };
    // Trusted data shows the feed was healthy, so p9's settlement is unsupported.
    const healthySvc = new ReevaluationService(new AdjudicationLedger(), new TrustedReadingHistory(), CONFIG);
    healthySvc.ledger.record(rec({ policyId: "p9", outcome: "settled", decidedAt: T0 + 20 * MIN }));
    const run = healthySvc.plan(FEED, T0 + 60 * MIN, T0 + 60 * MIN, [
      { observedAt: T0 + 19 * MIN, value: 1.0 },
      { observedAt: T0 + 25 * MIN, value: 1.0 },
    ])!;
    const id = `p9:${T0 + 20 * MIN}`;
    expect(run.items[0].action).toBe("flag_overpayment");
    await healthySvc.apply(run.runId, executor, "ops", T0);
    expect(run.itemStatus[id].status).toBe("flagged");
    expect(executor.settle).not.toHaveBeenCalled();

    healthySvc.approveReversal(run.runId, id, "ops-bob", "confirmed with treasury", T0 + 1);
    healthySvc.approveReversal(run.runId, id, "ops-bob", "duplicate click", T0 + 2);
    expect(run.itemStatus[id].status).toBe("reversal_approved");
    expect(run.audit.filter((a) => a.event === "reversal_approved")).toEqual([
      { at: T0 + 1, actor: "ops-bob", event: "reversal_approved", recordId: id, detail: "confirmed with treasury" },
    ]);
    expect(Object.isFrozen(run.audit[0])).toBe(true);
    expect(() => healthySvc.approveReversal(run.runId, "nope", "ops", "x", T0)).toThrow(/not a flagged overpayment/);
  });

  it("rejects applying an unknown run", async () => {
    const svc = new ReevaluationService();
    await expect(svc.apply("nope", { settle: jest.fn() }, "ops", T0)).rejects.toThrow(/Unknown/);
  });
});

describe("feedIdForPolicy", () => {
  it("maps coverage types to feeds, including per-flight feeds", () => {
    expect(feedIdForPolicy(0)).toBe("usdc-usd");
    expect(feedIdForPolicy(4, { flightNumber: "BA117" })).toBe("flight-delay:BA117");
    expect(feedIdForPolicy(4)).toBe("flight-delay:UNKNOWN");
  });
});
