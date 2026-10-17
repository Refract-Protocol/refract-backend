import { test } from "node:test";
import assert from "node:assert/strict";
import { OverrideImpactPreviewService } from "./overrideImpactPreviewer.ts";

test("OverrideImpactPreviewService computes non-mutating preview, matches post-apply triggers, and links evidence ledger", () => {
  const service = new OverrideImpactPreviewService({
    previewTtlMs: 30_000,
    exposureCeiling: 50_000,
  });

  service.setFeedState("USDC-USD", 1.0, false);
  service.setActivePolicies([
    {
      policyId: "pol-1",
      feedId: "USDC-USD",
      triggerDirection: "below",
      threshold: 0.98,
      coverageAmount: 20_000,
      existingCorroboratedTriggered: false,
    },
    {
      policyId: "pol-2",
      feedId: "USDC-USD",
      triggerDirection: "below",
      threshold: 0.95,
      coverageAmount: 40_000,
      existingCorroboratedTriggered: false,
    },
  ]);

  // Preview depeg override to 0.96 -> triggers pol-1 (20k) but not pol-2
  const preview = service.previewOverride({
    feedId: "USDC-USD",
    proposedValue: 0.96,
    actor: "ops-preview@refract.finance",
    role: "previewer",
    rationale: "Manual override during primary provider outage",
    nowMs: 1_000,
  });

  // Preview does not mutate feed state
  assert.equal(service.getFeedState("USDC-USD")?.value, 1.0);
  assert.deepEqual(preview.newlyTriggeredPolicyIds, ["pol-1"]);
  assert.equal(preview.totalPayoutExposure, 20_000);
  assert.equal(preview.policyImpacts[0].inconsistentWithExistingEvidence, true);

  // Previewer role cannot apply override
  assert.throws(
    () =>
      service.applyOverride({
        previewId: preview.previewId,
        actor: "ops-preview@refract.finance",
        role: "previewer",
        nowMs: 2_000,
      }),
    /UNAUTHORIZED_APPLY_ROLE/
  );

  // Admin role applies override using previewId; triggered set matches preview
  const applied = service.applyOverride({
    previewId: preview.previewId,
    actor: "ops-admin@refract.finance",
    role: "admin",
    nowMs: 2_000,
  });
  assert.deepEqual(applied.triggeredPolicyIds, preview.newlyTriggeredPolicyIds);
  assert.equal(service.getFeedState("USDC-USD")?.value, 0.96);

  const ledger = service.getEvidenceLedger();
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0].recordType, "OVERRIDE_PREVIEW");
  assert.equal(ledger[1].recordType, "OVERRIDE_APPLIED");
  assert.equal(ledger[0].previewId, ledger[1].previewId);
});

test("OverrideImpactPreviewService rejects expired tokens, mutated policy snapshots, and unapproved exposure ceiling breaches", () => {
  const service = new OverrideImpactPreviewService({
    previewTtlMs: 10_000,
    exposureCeiling: 50_000,
  });

  service.setFeedState("USDC-USD", 1.0, false);
  service.setActivePolicies([
    {
      policyId: "pol-large",
      feedId: "USDC-USD",
      triggerDirection: "below",
      threshold: 0.98,
      coverageAmount: 75_000,
      existingCorroboratedTriggered: false,
    },
  ]);

  const preview = service.previewOverride({
    feedId: "USDC-USD",
    proposedValue: 0.95,
    actor: "admin@refract.finance",
    role: "admin",
    rationale: "Severe depeg test",
    nowMs: 1_000,
  });

  // Expired token rejected
  assert.throws(
    () =>
      service.applyOverride({
        previewId: preview.previewId,
        actor: "admin@refract.finance",
        role: "admin",
        nowMs: 20_000,
      }),
    /EXPIRED_PREVIEW_TOKEN/
  );

  // Exposure ceiling exceeded without approval token
  assert.throws(
    () =>
      service.applyOverride({
        previewId: preview.previewId,
        actor: "admin@refract.finance",
        role: "admin",
        nowMs: 5_000,
      }),
    /EXPOSURE_CEILING_EXCEEDED/
  );

  // Mutating active policies after preview invalidates preview
  service.setActivePolicies([
    {
      policyId: "pol-large",
      feedId: "USDC-USD",
      triggerDirection: "below",
      threshold: 0.98,
      coverageAmount: 80_000,
      existingCorroboratedTriggered: false,
    },
  ]);
  assert.throws(
    () =>
      service.applyOverride({
        previewId: preview.previewId,
        actor: "admin@refract.finance",
        role: "admin",
        ceilingApprovalToken: "director-signoff-1",
        nowMs: 5_000,
      }),
    /POLICY_SNAPSHOT_MUTATED_SINCE_PREVIEW/
  );
});
