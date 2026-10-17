import { test } from "node:test";
import assert from "node:assert/strict";
import { IncidentPostmortemGenerator } from "./incidentPostmortemGenerator.ts";

test("IncidentPostmortemGenerator groups nearby breaker trips, redacts secrets, and renders deterministic postmortem markdown", () => {
  const generator = new IncidentPostmortemGenerator({
    groupingWindowMs: 60_000,
    maxTimelineEvents: 3,
  });

  // 1. Open incident on circuit breaker trip (contains secret in summary that must be redacted)
  const inc1 = generator.openOrGroupIncident({
    feedId: "USDC-DEPEG",
    triggerClass: "CIRCUIT_BREAKER_TRIP",
    timestampMs: 1_000_000,
    summary: "Provider jump detected api_key=supersecret123",
  });
  assert.equal(inc1.incidentId, "INC-0001");

  // 2. Second trigger within 60s grouping window attaches to INC-0001 instead of creating INC-0002
  const incGrouped = generator.openOrGroupIncident({
    feedId: "USDC-DEPEG",
    triggerClass: "QUORUM_FAILURE",
    timestampMs: 1_020_000,
    summary: "Quorum fell below 3 sources",
  });
  assert.equal(incGrouped.incidentId, "INC-0001");

  // 3. Append claim hold + extra event to trigger pagination truncation (>3 events)
  generator.appendEvent("INC-0001", {
    eventId: "ev-claim-1",
    timestampMs: 1_030_000,
    eventType: "CLAIM_HELD",
    feedId: "USDC-DEPEG",
    summary: "Held payout claim-99 pending corroboration",
    payoutExposureUsd: 25_000,
    metadata: { apiKey: "hidden-key" },
  });
  generator.appendEvent("INC-0001", {
    eventId: "ev-mode-1",
    timestampMs: 1_040_000,
    eventType: "TRUST_MODE_CHANGE",
    feedId: "USDC-DEPEG",
    summary: "Operator paused feed",
  });

  const md1 = generator.renderPostmortemMarkdown("INC-0001");
  const md2 = generator.renderPostmortemMarkdown("INC-0001");

  // Deterministic output
  assert.equal(md1, md2);

  // Secret redacted
  assert.equal(md1.includes("supersecret123"), false);
  assert.equal(md1.includes("hidden-key"), false);
  assert.ok(md1.includes("api_key=[REDACTED]"));

  // Sections & exposure present
  assert.ok(md1.includes("## Impact Summary"));
  assert.ok(md1.includes("$25000.00"));
  assert.ok(md1.includes("## Chronological Timeline"));
  assert.ok(md1.includes("[TRUNCATED: 1 additional ledger event(s) omitted for pagination]"));
  assert.ok(md1.includes("## Open Questions & Human Root-Cause Analysis"));
});
