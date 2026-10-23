import { test } from "node:test";
import assert from "node:assert/strict";
import { executeAdversarialRedTeamSuite } from "./adversarialRedTeamSuite.ts";

test("unconfigured adversarial scenarios are blocked and never reported as verified", async () => {
  const report = await executeAdversarialRedTeamSuite();

  assert.equal(report.allHighSeverityClosed, false);
  assert.equal(report.findings.length, 6);
  for (const finding of report.findings) {
    assert.equal(finding.status, "blocked");
    assert.equal(finding.retestStatus, "not_run");
    assert.ok(finding.blocker);
  }
});

test("simulation results do not count as staging verification", async () => {
  const executor = {
    environment: "simulation" as const,
    executeAttack: async () => ({
      attackObserved: "Synthetic unsigned submission was rejected.",
      expectedBehavior: "Reject the submission before it enters consensus.",
      controlBlockedAttack: true,
      remediationOwner: "oracle-ingestion",
    }),
    retest: async () => ({
      attackObserved: "Synthetic unsigned submission was rejected.",
      expectedBehavior: "Reject the submission before it enters consensus.",
      controlBlockedAttack: true,
      remediationOwner: "oracle-ingestion",
    }),
  };
  const report = await executeAdversarialRedTeamSuite({
    FORGED_UNSIGNED_SUBMISSION: executor,
  });

  const finding = report.findings.find(
    (entry) => entry.scenarioId === "FORGED_UNSIGNED_SUBMISSION",
  );
  assert.equal(finding?.status, "failed");
  assert.equal(finding?.retestStatus, "passed");
  assert.equal(report.allHighSeverityClosed, false);
});

test("failed retests are reported as failures", async () => {
  const executor = {
    environment: "staging" as const,
    executeAttack: async () => ({
      attackObserved: "A read-only identity changed a payout setting.",
      expectedBehavior: "Reject the action and record the authorization failure.",
      controlBlockedAttack: false,
      remediationOwner: "platform-security",
    }),
    retest: async () => ({
      attackObserved: "The payout setting was still changed.",
      expectedBehavior: "Reject the action and record the authorization failure.",
      controlBlockedAttack: false,
      remediationOwner: "platform-security",
    }),
  };
  const report = await executeAdversarialRedTeamSuite({
    ADMIN_PRIVILEGE_ESCALATION: executor,
  });

  const finding = report.findings.find(
    (entry) => entry.scenarioId === "ADMIN_PRIVILEGE_ESCALATION",
  );
  assert.equal(finding?.status, "failed");
  assert.equal(finding?.retestStatus, "failed");
  assert.equal(report.allHighSeverityClosed, false);
});
