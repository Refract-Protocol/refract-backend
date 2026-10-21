import { MetricId, OracleSourceAdapter, RawObservation, TrustTier } from "../adapters/source-adapter";
import { OracleSourceRegistry } from "../adapters/source-registry";
import { EvidenceNotDurableError } from "../evidence/evidence-record";
import { OracleEvidenceBuffer } from "../evidence/oracle-evidence-buffer";
import { authorizesPayout } from "./consensus-decision";
import { ConsensusOptions, ConsensusService } from "./consensus.service";

const evidence = { url: "u", status: 200, bodySha256: "sha", bytes: 1, excerpt: "{}", capturedAt: 0 };

type Source = { value?: number; error?: Error };
function source(id: string, metric: MetricId, state: Source, trustTier: TrustTier = "live"): OracleSourceAdapter & { state: Source } {
  return {
    id,
    displayName: id,
    trustTier,
    metrics: [metric],
    state,
    async fetch(): Promise<RawObservation> {
      if (this.state.error) throw this.state.error;
      return { value: this.state.value as number, observedAt: Date.now(), evidence };
    },
  } as OracleSourceAdapter & { state: Source };
}

function fakeEvidence() {
  let seq = 0;
  const appended: unknown[] = [];
  const buffer = {
    fail: false,
    append: jest.fn(async (entries: unknown[]) => {
      if (buffer.fail) throw new EvidenceNotDurableError("disk full");
      appended.push(...entries);
      return entries.map(() => ++seq);
    }),
  };
  return { buffer, appended, asBuffer: buffer as unknown as OracleEvidenceBuffer };
}

function setup(adapters: OracleSourceAdapter[], options: Partial<ConsensusOptions> = {}) {
  const registry = new OracleSourceRegistry({ timeoutMs: 100, quarantineAfterFailures: 99, quarantineMs: 0 });
  adapters.forEach((a) => registry.register(a));
  const ev = fakeEvidence();
  const consensus = new ConsensusService(registry, ev.asBuffer, {
    minSources: 1,
    targetSources: 2,
    minConfidence: 0.5,
    decisionTtlMs: 0,
    ...options,
  });
  return { consensus, ev };
}

describe("ConsensusService", () => {
  it("produces an actionable, triggered, recorded decision from agreeing sources", async () => {
    const { consensus, ev } = setup([
      source("a", "usdc.usd.price", { value: 0.9 }),
      source("b", "usdc.usd.price", { value: 0.91 }),
    ]);
    const d = await consensus.decide(0);
    expect(d).toMatchObject({
      coverageType: "StablecoinDepeg",
      status: "ok",
      actionable: true,
      triggered: true,
      value: 0.905,
      quorum: { required: 1, available: 2, met: true },
      evidenceSeq: 1,
      id: "StablecoinDepeg@1",
    });
    expect(d.confidence).toBeCloseTo(0.5);
    expect(d.inputs.map((i) => i.evidenceSha256)).toEqual(["sha", "sha"]);
    expect(authorizesPayout(d)).toBe(true);
    expect(ev.appended[0]).toMatchObject({ kind: "decision", source: "consensus", severity: "triggered" });
  });

  it("is insufficient when quorum is not met", async () => {
    const { consensus } = setup(
      [source("a", "usdc.usd.price", { value: 0.9 }), source("b", "usdc.usd.price", { error: new Error("down") })],
      { minSources: 2 },
    );
    const d = await consensus.decide(0);
    expect(d).toMatchObject({ status: "insufficient", actionable: false, triggered: false, value: null });
    expect(d.blockers[0]).toMatch(/quorum not met: 1 of 2/);
    expect(d.failures).toEqual([{ sourceId: "b", reason: "fetch_error" }]);
  });

  it("is conflicted when sources disagree beyond the allowed spread", async () => {
    const { consensus } = setup([
      source("a", "usdc.usd.price", { value: 0.9 }),
      source("b", "usdc.usd.price", { value: 1.0 }),
    ]);
    const d = await consensus.decide(0);
    expect(d).toMatchObject({ status: "conflicted", actionable: false });
    expect(authorizesPayout(d)).toBe(false);
  });

  it("is degraded but still actionable when one of several sources fails", async () => {
    const { consensus } = setup(
      [source("a", "usdc.usd.price", { value: 0.9 }), source("b", "usdc.usd.price", { error: new Error("x") })],
      { minConfidence: 0.4 },
    );
    const d = await consensus.decide(0);
    expect(d).toMatchObject({ status: "degraded", actionable: true, triggered: true });
  });

  it("blocks decisions whose confidence is below the minimum", async () => {
    const { consensus } = setup([source("a", "usdc.usd.price", { value: 0.9 })], { minConfidence: 0.75 });
    const d = await consensus.decide(0);
    expect(d.actionable).toBe(false);
    expect(d.blockers.join()).toMatch(/confidence 0.5 below required 0.75/);
  });

  it("ignores mock-tier sources for quorum", async () => {
    const { consensus } = setup([source("m", "usdc.usd.price", { value: 0.5 }, "mock")]);
    const d = await consensus.decide(0);
    expect(d).toMatchObject({ status: "insufficient", actionable: false });
  });

  it.each([2, 4])("never authorizes coverage type %d, which has no live source", async (coverageType) => {
    const { consensus, ev } = setup([]);
    const d = await consensus.decide(coverageType);
    expect(d).toMatchObject({ status: "insufficient", actionable: false, metric: null });
    expect(ev.appended).toHaveLength(1); // still recorded
  });

  it("marks a decision unrecorded and non-actionable when evidence cannot be made durable", async () => {
    const { consensus, ev } = setup([source("a", "usdc.usd.price", { value: 0.9 })]);
    ev.buffer.fail = true;
    const d = await consensus.decide(0);
    expect(d).toMatchObject({ status: "unrecorded", actionable: false, evidenceSeq: null, triggered: true });
    expect(authorizesPayout(d)).toBe(false);
  });

  it("reuses a decision within the TTL so a scan does not refetch per policy", async () => {
    const a = source("a", "usdc.usd.price", { value: 1 });
    const spy = jest.spyOn(a, "fetch");
    const { consensus } = setup([a], { decisionTtlMs: 60_000 });
    const [d1, d2] = await Promise.all([consensus.decide(0), consensus.decide(0)]);
    expect(d1).toBe(d2);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown coverage types", async () => {
    await expect(setup([]).consensus.decide(9)).rejects.toThrow(/Unknown coverageType 9/);
  });
});
