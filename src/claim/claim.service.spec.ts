// The real modules pull in config/DB wiring that is irrelevant here; the
// service only needs these classes as DI tokens.
jest.mock("../policy/policy.service", () => ({ PolicyService: class PolicyService {} }));
jest.mock("./claim-settlement.service", () => ({ ClaimSettlementService: class ClaimSettlementService {} }));

// These tests exercise single-scan trigger/payout plumbing, so turn off the
// trigger dwell (covered in trigger/trigger-stability.spec.ts). Must be set
// before ClaimService is constructed.
process.env.TRIGGER_MIN_DWELL_SECONDS = "0";
process.env.TRIGGER_MIN_CONFIRMATIONS = "1";

import { ConsensusDecision } from "../oracle/consensus/consensus-decision";
import type { ConsensusService } from "../oracle/consensus/consensus.service";
import type { PolicyService, StoredPolicy } from "../policy/policy.service";
import type { ClaimSettlementService } from "./claim-settlement.service";
import { ClaimService } from "./claim.service";
import { authorizeSettlement } from "./settlement-authorization";

function buildPolicy(overrides: Partial<StoredPolicy> = {}): StoredPolicy {
  return {
    id: "policy-1",
    holder: "GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ12",
    coverageType: 0,
    coverageTypeName: "Stablecoin Depeg",
    coverageAmount: "1000000000",
    premium: "3000000",
    durationDays: 30,
    expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    isActive: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as StoredPolicy;
}

function buildDecision(overrides: Partial<ConsensusDecision> = {}): ConsensusDecision {
  return {
    id: "StablecoinDepeg@7",
    coverageType: "StablecoinDepeg",
    metric: "usdc.usd.price",
    value: 0.9,
    threshold: 0.95,
    direction: "below",
    triggered: true,
    actionable: true,
    status: "ok",
    confidence: 1,
    quorum: { required: 2, available: 2, met: true },
    inputs: [
      { sourceId: "coingecko", value: 0.9, rawValue: 0.9, observedAt: 1, evidenceSha256: "a", samples: 5, spanMs: 240_000 },
      { sourceId: "other", value: 0.9, rawValue: 0.89, observedAt: 1, evidenceSha256: "b", samples: 5, spanMs: 240_000 },
    ],
    failures: [],
    blockers: [],
    decidedAt: 123,
    evidenceSeq: 7,
    ...overrides,
  };
}

function buildServices(policies: StoredPolicy[] = [], decision: ConsensusDecision = buildDecision()) {
  const policyService = {
    listActive: jest.fn().mockReturnValue(policies),
    deactivate: jest.fn(),
  };
  const consensus = { decide: jest.fn().mockResolvedValue(decision) };
  const settlement = {
    settleClaim: jest.fn().mockResolvedValue({ settled: true, txHash: "tx-1" }),
    isConfigured: jest.fn().mockReturnValue(true),
  };
  const service = new ClaimService(
    policyService as unknown as PolicyService,
    consensus as unknown as ConsensusService,
    settlement as unknown as ClaimSettlementService,
  );
  return { service, policyService, consensus, settlement };
}

describe("ClaimService (consensus-gated settlement)", () => {
  it("does nothing when there are no active policies", async () => {
    const { service, consensus } = buildServices();
    expect(await service.processTriggered()).toEqual([]);
    expect(consensus.decide).not.toHaveBeenCalled();
  });

  it("settles a policy only on an actionable, triggered, recorded decision and links the decision", async () => {
    const policy = buildPolicy({ coverageAmount: "5000000000" });
    const { service, settlement, policyService } = buildServices([policy]);

    const results = await service.processTriggered();

    expect(settlement.settleClaim).toHaveBeenCalledWith(policy.id, policy.holder, BigInt("5000000000"));
    expect(policyService.deactivate).toHaveBeenCalledWith(policy.id);
    expect(results[0]).toMatchObject({
      triggered: true,
      payout: "5000000000",
      decisionId: "StablecoinDepeg@7",
      settlementTxHash: "tx-1",
      triggerDetectedAt: 123,
    });
    expect(results[0].reason).toContain("sources=[coingecko,other]");
    expect(service.getStats()).toMatchObject({ processedClaims: 1, totalPayout: "5000000000" });
  });

  it.each([
    ["insufficient", { status: "insufficient", actionable: false, blockers: ["quorum not met"] }],
    ["conflicted", { status: "conflicted", actionable: false, blockers: ["sources disagree"] }],
    ["unrecorded", { status: "unrecorded", actionable: false, evidenceSeq: null, blockers: ["not recorded"] }],
    ["not triggered", { triggered: false }],
  ] as const)("does not settle when the decision is %s", async (_label, overrides) => {
    const { service, settlement, policyService } = buildServices([buildPolicy()], buildDecision(overrides as Partial<ConsensusDecision>));
    expect(await service.processTriggered()).toEqual([]);
    expect(settlement.settleClaim).not.toHaveBeenCalled();
    expect(policyService.deactivate).not.toHaveBeenCalled();
  });

  it("asks consensus for the policy's coverage type and subject", async () => {
    const { service, consensus } = buildServices(
      [buildPolicy({ coverageType: 4, triggerParams: { flightNumber: "BA249" } }), buildPolicy({ id: "p2", coverageType: 3 })],
      buildDecision({ triggered: false }),
    );
    await service.processTriggered();
    expect(consensus.decide).toHaveBeenNthCalledWith(1, 4, "BA249");
    expect(consensus.decide).toHaveBeenNthCalledWith(2, 3, undefined);
  });

  it("refuses a decision for a different coverage type", async () => {
    const { service, settlement } = buildServices(
      [buildPolicy({ coverageType: 1 })],
      buildDecision({ coverageType: "StablecoinDepeg" }),
    );
    await service.processTriggered();
    expect(settlement.settleClaim).not.toHaveBeenCalled();
  });

  it("keeps the policy active when settlement does not confirm", async () => {
    const { service, settlement, policyService } = buildServices([buildPolicy()]);
    settlement.settleClaim.mockResolvedValue({ settled: false, error: "rpc timeout" });
    expect(await service.processTriggered()).toEqual([]);
    expect(policyService.deactivate).not.toHaveBeenCalled();
  });

  it("continues scanning when one policy errors", async () => {
    const { service, consensus, settlement } = buildServices([buildPolicy({ id: "a" }), buildPolicy({ id: "b" })]);
    consensus.decide.mockRejectedValueOnce(new Error("boom"));
    const results = await service.processTriggered();
    expect(results.map((r) => r.policyId)).toEqual(["b"]);
    expect(settlement.settleClaim).toHaveBeenCalledTimes(1);
  });
});

describe("authorizeSettlement", () => {
  it("only authorizes actionable, triggered, recorded decisions for the matching coverage type", () => {
    const policy = buildPolicy();
    expect(authorizeSettlement(policy, "StablecoinDepeg", buildDecision()).ok).toBe(true);
    expect(authorizeSettlement(policy, "MarketCrash", buildDecision()).ok).toBe(false);
    expect(authorizeSettlement(policy, "StablecoinDepeg", buildDecision({ actionable: false })).ok).toBe(false);
    expect(authorizeSettlement(policy, "StablecoinDepeg", buildDecision({ triggered: false })).ok).toBe(false);
    expect(authorizeSettlement(policy, "StablecoinDepeg", buildDecision({ evidenceSeq: null })).ok).toBe(false);
  });
});
