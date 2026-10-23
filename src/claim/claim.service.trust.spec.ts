// policy.service.ts and oracle-event.repository.ts pull in heavy runtime
// deps; ClaimService only needs their shapes here.
jest.mock("../policy/policy.service", () => ({ PolicyService: class {} }));
jest.mock("../oracle/oracle-event.repository", () => ({ OracleEventRepository: class {} }));
jest.mock("../oracle/oracle.service", () => ({ OracleService: class {} }));
jest.mock("./claim-settlement.service", () => ({ ClaimSettlementService: class {} }));

import { ClaimService } from "./claim.service";
import type { StoredPolicy } from "../policy/policy.service";
import type { OracleReading } from "../oracle/oracle-reading";
import type { AdjudicationRecord } from "./reevaluation/adjudication";
import type { FeedTrustState } from "../oracle/regions/region-quorum";

const policy: StoredPolicy = {
  id: "p1",
  holder: "GHOLDER",
  coverageType: 0,
  coverageTypeName: "Stablecoin Depeg",
  coverageAmount: "1000000000",
  premium: "3000000",
  durationDays: 30,
  expiresAt: Math.floor(Date.now() / 1000) + 86_400,
  isActive: true,
  createdAt: new Date().toISOString(),
};

const reading = (value: number): OracleReading => ({
  coverageType: "StablecoinDepeg",
  type: "oracle_update",
  value,
  threshold: 0.95,
  severity: "high",
  message: `USDC price: $${value}`,
});

function build(env: Record<string, string>, trust: FeedTrustState | null) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const policyService = { listActive: jest.fn(() => [policy]), deactivate: jest.fn() };
  const oracleService = { checkStablecoinDepeg: jest.fn(async () => reading(0.9)) };
  const settlement = { settleClaim: jest.fn(async () => ({ settled: true, txHash: "tx" })), isConfigured: () => true };
  const repo = { record: jest.fn(async () => undefined) };
  const service = new ClaimService(policyService as never, oracleService as never, settlement as never, repo as never);
  process.env = saved;
  const records: AdjudicationRecord[] = [];
  service.setTrustGate(() => trust);
  service.onAdjudication((r) => records.push(r));
  return { service, settlement, oracleService, records };
}

const NO_DWELL = { TRIGGER_MIN_DWELL_SECONDS: "0", TRIGGER_MIN_CONFIRMATIONS: "1" };

describe("ClaimService trust integration", () => {
  it("holds a triggered payout when the feed isn't trusted and records the hold", async () => {
    const { service, settlement, records } = build(NO_DWELL, "degraded");
    expect(await service.processTriggered()).toEqual([]);
    expect(settlement.settleClaim).not.toHaveBeenCalled();
    expect(records).toEqual([expect.objectContaining({ policyId: "p1", outcome: "held", trustState: "degraded", feedId: "usdc-usd", paid: "0" })]);
  });

  it("records a skipped decision when nothing triggers under an untrusted feed", async () => {
    const { service, oracleService, records } = build(NO_DWELL, "under_corroborated");
    oracleService.checkStablecoinDepeg.mockResolvedValue(reading(1.0));
    await service.processTriggered();
    expect(records[0]).toMatchObject({ outcome: "skipped", readingValue: 1.0 });
  });

  it("settles and records the settlement when holding is disabled", async () => {
    const { service, settlement, records } = build({ ...NO_DWELL, CLAIM_HOLD_ON_UNTRUSTED_FEED: "false" }, "degraded");
    await service.processTriggered();
    expect(settlement.settleClaim).toHaveBeenCalledTimes(1);
    expect(records[0]).toMatchObject({ outcome: "settled", paid: "1000000000", settlementTxHash: "tx" });
  });

  it("pays normally and records nothing when the feed is trusted or ungated", async () => {
    for (const trust of ["trusted", null] as const) {
      const { service, settlement, records } = build(NO_DWELL, trust);
      expect(await service.processTriggered()).toHaveLength(1);
      expect(settlement.settleClaim).toHaveBeenCalledTimes(1);
      expect(records).toEqual([]);
    }
  });

  it("applies the minimum dwell: a first breach alone does not pay", async () => {
    const { service, settlement } = build({ TRIGGER_MIN_DWELL_SECONDS: "300", TRIGGER_MIN_CONFIRMATIONS: "2" }, null);
    expect(await service.processTriggered()).toEqual([]);
    expect(settlement.settleClaim).not.toHaveBeenCalled();
  });

  it("settles a re-adjudicated claim through the normal payout path", async () => {
    const { service, settlement } = build(NO_DWELL, null);
    expect(await service.settleFromReevaluation(policy, "reeval_x")).toEqual({ settled: true, txHash: "tx" });
    expect(settlement.settleClaim).toHaveBeenCalledWith("p1", "GHOLDER", BigInt("1000000000"));
  });
});
