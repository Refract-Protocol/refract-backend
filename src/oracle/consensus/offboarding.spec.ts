import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runOracleOpsCli } from "./cli";
import { InMemoryCredentialStore, SecretsManagerCredentialStore } from "./credential-store";
import { OffboardingService } from "./offboarding";
import { reconstructConsensusState, serializeReconstruction } from "./reconstruction";
import { ConsensusHarness } from "./testing/fixtures";

const FEED = "StablecoinDepeg";
const DAY = 86_400_000;

function setup(opts: { ledgerPath?: string } = {}) {
  const h = new ConsensusHarness(opts);
  h.seedFeed(FEED, ["coingecko", "kraken"], { expectedSources: 2 });
  h.consensus.registerSource({
    sourceId: "paidfeed",
    providerId: "acme-data",
    feedId: FEED,
    weight: 1,
    retentionDays: 7,
    credentialRef: "refract/sources/acme-data",
  });
  const creds = new InMemoryCredentialStore();
  creds.set("refract/sources/acme-data", "s3cr3t");
  const svc = new OffboardingService(h.ledger, h.payloads, creds);

  // Old evidence (beyond the 7-day licence by the time we offboard)...
  h.read("coingecko", 0.9); h.read("kraken", 0.91); const oldPaid = h.read("paidfeed", 0.905);
  const oldDecision = h.consensus.decide(FEED);
  h.advance(10 * DAY);
  // ...and recent evidence still inside it.
  h.read("coingecko", 0.99); h.read("kraken", 0.99); const newPaid = h.read("paidfeed", 0.991);
  const newDecision = h.consensus.decide(FEED);
  return { h, svc, creds, oldPaid, newPaid, oldDecision, newDecision };
}

const actor = { actor: "ops@refract", reason: "contract ended 2026-10-31" };

describe("provider offboarding", () => {
  it("dry run reports exactly what would change and changes nothing", async () => {
    const { h, svc, creds, oldPaid, newPaid } = setup();
    const before = h.ledger.events().length;
    const report = await svc.offboard("paidfeed", { ...actor, dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.plan).toMatchObject({
      alreadyRetired: false,
      retireAsVersion: 2,
      credential: { credentialRef: "refract/sources/acme-data", action: "revoke" },
      quorum: { minSources: 2, remainingEligibleSources: 2, dropsBelowQuorum: false },
      preserved: { readings: 2, decisions: 2, payloadHashes: 2 },
    });
    expect(report.plan.payloads.purge.map((p) => p.hash)).toEqual([oldPaid.payloadHash]);
    expect(report.plan.payloads.retain).toEqual([
      expect.objectContaining({ hash: newPaid.payloadHash, reason: "within_license_retention", purgeAfter: expect.any(String) }),
    ]);
    expect(h.ledger.events()).toHaveLength(before);
    expect(h.payloads.has(oldPaid.payloadHash!)).toBe(true);
    expect(creds.has("refract/sources/acme-data")).toBe(true);
  });

  it("executes the plan: retires, revokes, purges beyond retention, audits", async () => {
    const { h, svc, creds, oldPaid, newPaid } = setup();
    const dry = await svc.offboard("paidfeed", { ...actor, dryRun: true });
    const run = await svc.offboard("paidfeed", actor);

    expect(run.executed).toEqual({ retired: true, credentialRevoked: true, purged: 1 });
    expect(run.plan).toEqual(dry.plan);
    expect(creds.has("refract/sources/acme-data")).toBe(false);
    expect(h.payloads.has(oldPaid.payloadHash!)).toBe(false);
    expect(h.payloads.has(newPaid.payloadHash!)).toBe(true);

    const eligibility = h.consensus.evaluate(FEED, h.ledger.now()).eligibility.find((e) => e.sourceId === "paidfeed");
    expect(eligibility).toMatchObject({ eligible: false, reason: "retired", status: "retired", version: 2 });
    expect(() => h.read("paidfeed", 1)).toThrow(/retired/);

    const audit = h.ledger.events().filter((e) => e.kind === "audit" && e.action.startsWith("source.offboarding"));
    expect(audit.map((e) => e.kind === "audit" && e.action)).toEqual(["source.offboarding_started", "source.offboarding_completed"]);
    expect(audit[0]).toMatchObject({ actor: "ops@refract", reason: "contract ended 2026-10-31" });
    const started = h.ledger.events().find((e) => e.kind === "offboarding_started");
    expect(started).toMatchObject({ purgeScope: [oldPaid.payloadHash] });
    // Credentials never enter the ledger, only the reference.
    expect(JSON.stringify(h.ledger.events())).not.toContain("s3cr3t");
  });

  it("keeps historical decisions reconstructible and verifiable after the purge", async () => {
    const { h, svc, oldPaid, oldDecision } = setup();
    const q = { feedId: FEED, at: oldDecision.at };
    const before = serializeReconstruction(reconstructConsensusState(h.ledger.events(), q));
    await svc.offboard("paidfeed", actor);
    const after = serializeReconstruction(reconstructConsensusState(h.ledger.events(), q));

    expect(after).toBe(before);
    expect(JSON.parse(after).consistency).toBe("matches_recorded");
    expect(JSON.parse(after).contributingReadings).toContainEqual(expect.objectContaining({ sourceId: "paidfeed", payloadHash: oldPaid.payloadHash, value: 0.905 }));
    expect(svc.payloadStatus(oldPaid.payloadHash!)).toMatchObject({
      available: false,
      bodyMatchesHash: null,
      purged: { reason: expect.stringMatching(/retention/) },
      referencedByReadings: [oldPaid.readingId],
    });
  });

  it("is idempotent on re-run and the retention sweep purges what later ages out", async () => {
    const { h, svc, newPaid } = setup();
    await svc.offboard("paidfeed", actor);
    const second = await svc.offboard("paidfeed", actor);
    expect(second.executed).toEqual({ retired: false, credentialRevoked: false, purged: 0 });
    expect(h.ledger.events().filter((e) => e.kind === "source_version" && e.sourceId === "paidfeed" && e.status === "retired")).toHaveLength(1);

    expect(await svc.sweepRetention()).toBe(0);
    h.advance(8 * DAY);
    expect(await svc.sweepRetention()).toBe(1);
    expect(h.payloads.has(newPaid.payloadHash!)).toBe(false);
    expect(await svc.sweepRetention()).toBe(0);
  });

  it("resumes a partially failed purge under the same offboarding id", async () => {
    const { h } = setup();
    // Make a second purgeable payload.
    h.read("paidfeed", 0.95); h.advance(10 * DAY);
    const creds = new InMemoryCredentialStore();
    const svc = new OffboardingService(h.ledger, h.payloads, creds);
    const realDelete = h.payloads.delete.bind(h.payloads);
    let calls = 0;
    jest.spyOn(h.payloads, "delete").mockImplementation((hash) => {
      if (++calls === 2) throw new Error("EIO");
      realDelete(hash);
    });

    await expect(svc.offboard("paidfeed", actor)).rejects.toThrow(/Re-run to resume/);
    const purgedSoFar = h.ledger.events().filter((e) => e.kind === "payload_purged");
    expect(purgedSoFar).toHaveLength(1);

    const resumed = await svc.offboard("paidfeed", actor);
    expect(resumed.executed?.retired).toBe(false);
    const starts = h.ledger.events().filter((e) => e.kind === "offboarding_started");
    expect(starts).toHaveLength(1);
    expect(resumed.offboardingId).toBe(starts[0].kind === "offboarding_started" && starts[0].offboardingId);
    expect(h.ledger.events().filter((e) => e.kind === "payload_purged").length).toBeGreaterThanOrEqual(2);
    expect(h.ledger.events().some((e) => e.kind === "audit" && e.action === "source.offboarding_failed")).toBe(true);
  });

  it("refuses to drop a feed below quorum unless acknowledged", async () => {
    const h = new ConsensusHarness();
    h.seedFeed(FEED, ["a", "b"]);
    const svc = new OffboardingService(h.ledger, h.payloads, new InMemoryCredentialStore());
    await expect(svc.offboard("a", actor)).rejects.toThrow(/leaves 1 eligible source/);
    expect(h.ledger.events().some((e) => e.kind === "offboarding_started")).toBe(false);
    await expect(svc.offboard("a", { ...actor, acknowledgeQuorumLoss: true })).resolves.toMatchObject({ executed: { retired: true } });
  });

  it("retains payloads referenced by an open dispute (held claim)", async () => {
    const { h, svc } = setup();
    h.advance(10 * DAY);
    h.read("coingecko", 0.9, { signature: "pending" }); h.read("kraken", 0.9); const disputed = h.read("paidfeed", 0.9);
    h.holds.gate({ policyId: "p1", holder: "G", feedId: FEED, policyExpiresAt: h.ledger.now() + 30 * DAY });
    h.advance(10 * DAY);

    const plan = (await svc.offboard("paidfeed", { ...actor, dryRun: true })).plan;
    expect(plan.openDisputes).toEqual([expect.objectContaining({ policyId: "p1" })]);
    expect(plan.payloads.retain).toContainEqual(expect.objectContaining({ hash: disputed.payloadHash, reason: "open_dispute" }));
    expect(plan.payloads.purge.map((p) => p.hash)).not.toContain(disputed.payloadHash);
  });

  it("retains a body that an active source also references", async () => {
    const { h, svc } = setup();
    const body = JSON.stringify({ price: 0.97, upstream: "same" });
    h.read("paidfeed", 0.97, { payload: body });
    h.read("coingecko", 0.97, { payload: body });
    h.advance(10 * DAY);
    const plan = (await svc.offboard("paidfeed", { ...actor, dryRun: true })).plan;
    expect(plan.payloads.retain).toContainEqual(expect.objectContaining({ reason: "shared_with_active_source" }));
  });

  it("supports re-onboarding without ambiguity about which config applied when", async () => {
    const { h, svc, oldDecision } = setup();
    await svc.offboard("paidfeed", actor);
    const retiredAt = h.ledger.now();
    h.advance(DAY);
    h.consensus.registerSource({ sourceId: "paidfeed", providerId: "acme-data", feedId: FEED, weight: 2, retentionDays: 3, credentialRef: "refract/sources/acme-data-v2", warmupMs: DAY });
    h.read("paidfeed", 1);

    const versionAt = (t: number) => reconstructConsensusState(h.ledger.events(), { feedId: FEED, at: t }).sources.find((s) => s.sourceId === "paidfeed");
    expect(versionAt(oldDecision.at)).toMatchObject({ version: 1, status: "active", weight: 1 });
    expect(versionAt(retiredAt)).toMatchObject({ version: 2, status: "retired" });
    expect(versionAt(h.ledger.now())).toMatchObject({ version: 3, status: "warmup", weight: 2 });
    // The new contract's credential is a fresh reference that a later offboarding will revoke.
    expect((await svc.offboard("paidfeed", { ...actor, dryRun: true })).plan.credential).toEqual({ credentialRef: "refract/sources/acme-data-v2", action: "revoke" });
  });

  it("CLI dry run matches the service plan", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offboard-"));
    const ledgerPath = path.join(dir, "evidence.jsonl");
    const { h, svc } = setup({ ledgerPath });
    const at = new Date(h.ledger.now()).toISOString();
    const cli = runOracleOpsCli(["offboard-plan", "--source", "paidfeed", "--at", at, "--ledger-file", ledgerPath]);
    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout)).toEqual(JSON.parse(JSON.stringify(svc.plan("paidfeed"))));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("SecretsManagerCredentialStore", () => {
  it("treats already-deleted secrets as success and surfaces other failures", async () => {
    const send = jest.fn();
    const store = new SecretsManagerCredentialStore({ send } as never, 7);
    send.mockResolvedValueOnce({});
    await store.delete("a");
    expect(send.mock.calls[0][0].input).toEqual({ SecretId: "a", RecoveryWindowInDays: 7 });

    send.mockRejectedValueOnce(Object.assign(new Error("nope"), { name: "ResourceNotFoundException" }));
    await expect(store.delete("b")).resolves.toBeUndefined();
    send.mockRejectedValueOnce(Object.assign(new Error("already scheduled for deletion"), { name: "InvalidRequestException" }));
    await expect(store.delete("c")).resolves.toBeUndefined();
    send.mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    await expect(store.delete("d")).rejects.toThrow("denied");
  });
});
