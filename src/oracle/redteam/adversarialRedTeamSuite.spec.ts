import { test } from "node:test";
import assert from "node:assert/strict";
import { executeAdversarialRedTeamSuite } from "./adversarialRedTeamSuite.ts";

test("executeAdversarialRedTeamSuite verifies all 6 adversarial threat scenarios are blocked and retested", () => {
  const report = executeAdversarialRedTeamSuite();
  assert.equal(report.allHighSeverityClosed, true);
  assert.equal(report.findings.length, 6);
  for (const finding of report.findings) {
    assert.equal(finding.blockedByControl, true);
    assert.equal(finding.retestPassed, true);
    assert.ok(finding.remediationOwner.length > 0);
  }
});
