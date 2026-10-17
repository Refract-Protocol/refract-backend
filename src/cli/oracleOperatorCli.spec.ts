import { test } from "node:test";
import assert from "node:assert/strict";
import { OracleOperatorCli } from "./oracleOperatorCli.ts";

test("OracleOperatorCli inspects feeds, readings, and decisions and enforces confirmation + audit logs on mutations", () => {
  const cli = new OracleOperatorCli();
  cli.seedFeed({
    feedId: "USDC-DEPEG",
    trustMode: "corroborated",
    paused: false,
    sources: [
      { sourceId: "coingecko", quarantined: false },
      { sourceId: "defillama", quarantined: false },
    ],
  });
  cli.seedReading({
    feedId: "USDC-DEPEG",
    sourceId: "coingecko",
    value: 0.9998,
    observedAtMs: 1_000,
  });
  cli.seedDecision({
    decisionId: "dec-1",
    feedId: "USDC-DEPEG",
    consensusValue: 0.9998,
    evidenceLinks: ["ev://dec-1/coingecko"],
    decidedAtMs: 1_050,
  });

  // Read-only commands succeed without confirmation
  const listRes = cli.execute({ command: "feeds:list" });
  assert.equal(listRes.exitCode, 0);

  const readingsRes = cli.execute({
    command: "readings:recent",
    feedId: "USDC-DEPEG",
  });
  assert.equal(readingsRes.exitCode, 0);

  const decisionsRes = cli.execute({
    command: "decisions:recent",
    feedId: "USDC-DEPEG",
  });
  assert.equal(decisionsRes.exitCode, 0);

  // Mutation without --confirm or --dry-run fails with exitCode=1
  const missingConfirm = cli.execute({
    command: "feed:pause",
    feedId: "USDC-DEPEG",
    operator: "alice@refract.finance",
    reason: "Upstream incident",
  });
  assert.equal(missingConfirm.exitCode, 1);
  assert.equal(cli.getAuditLog().length, 0);

  // Dry-run previews state without mutating or writing audit log
  const dryRunPause = cli.execute({
    command: "feed:pause",
    feedId: "USDC-DEPEG",
    operator: "alice@refract.finance",
    reason: "Upstream incident",
    dryRun: true,
  });
  assert.equal(dryRunPause.exitCode, 0);
  assert.equal(dryRunPause.dryRun, true);
  assert.equal(cli.getAuditLog().length, 0);

  // Confirmed pause + source quarantine writes audit records for every mutation
  const confirmedPause = cli.execute({
    command: "feed:pause",
    feedId: "USDC-DEPEG",
    operator: "alice@refract.finance",
    reason: "Upstream incident",
    confirm: true,
    nowMs: 2_000,
  });
  assert.equal(confirmedPause.exitCode, 0);

  const confirmedQuarantine = cli.execute({
    command: "source:quarantine",
    feedId: "USDC-DEPEG",
    sourceId: "coingecko",
    operator: "bob@refract.finance",
    reason: "Outlier spike",
    confirm: true,
    nowMs: 2_500,
  });
  assert.equal(confirmedQuarantine.exitCode, 0);

  const audits = cli.getAuditLog();
  assert.equal(audits.length, 2);
  assert.equal(audits[0].action, "feed:pause");
  assert.equal(audits[1].action, "source:quarantine");
  assert.equal(audits[1].targetId, "USDC-DEPEG:coingecko");
});
