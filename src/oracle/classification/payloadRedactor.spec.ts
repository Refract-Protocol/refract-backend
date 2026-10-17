import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ProviderPayloadClassifierAndRedactor,
  type CapturedEvidencePayloadRecord,
} from "./payloadRedactor.ts";

test("Issue #240: redacts passenger PII fields deterministically while preserving numerical consensus fields and reproducible evidence IDs", () => {
  const redactor = new ProviderPayloadClassifierAndRedactor();
  const now = 1_750_000_000_000;

  redactor.registerSourcePolicy({
    sourceId: "flightaware",
    dataClassification: "internal_evidence_only",
    requiresAttribution: true,
    attributionText: "Flight data powered by FlightAware",
    allowRawExternalExposure: false,
    piiFieldNames: ["seatAssignment"],
  });

  const rawFlightPayload = {
    flightNumber: "BA117",
    delayMinutes: 195,
    cancelled: false,
    passengerName: "Jane Doe",
    bookingReference: "PNR998877",
    seatAssignment: "14A",
    nestedManifest: {
      customerEmail: "jane@example.com",
      gateDelayBps: 6500,
    },
  };

  const captured1 = redactor.captureAndRedactPayload({
    sourceId: "flightaware",
    feedId: "FlightDelay",
    rawPayload: rawFlightPayload,
    capturedAtMs: now,
  });

  // Second capture with DIFFERENT raw PII values but identical flight telemetry produces the EXACT same evidenceId!
  const captured2 = redactor.captureAndRedactPayload({
    sourceId: "flightaware",
    feedId: "FlightDelay",
    rawPayload: {
      ...rawFlightPayload,
      passengerName: "Another Person",
      bookingReference: "OTHERPNR",
    },
    capturedAtMs: now + 5_000,
  });

  assert.equal(captured1.evidenceId, captured2.evidenceId);
  assert.equal(captured1.sanitizedPayload.delayMinutes, 195);
  assert.equal(captured1.sanitizedPayload.flightNumber, "BA117");
  assert.equal(captured1.sanitizedPayload.passengerName, "[REDACTED_PII]");
  assert.equal(captured1.sanitizedPayload.bookingReference, "[REDACTED_PII]");
  assert.equal(captured1.sanitizedPayload.seatAssignment, "[REDACTED_PII]");
  assert.equal(
    (captured1.sanitizedPayload.nestedManifest as Record<string, unknown>).customerEmail,
    "[REDACTED_PII]"
  );
  assert.equal(
    (captured1.sanitizedPayload.nestedManifest as Record<string, unknown>).gateDelayBps,
    6500
  );
  // Logs the field names redacted without logging raw PII values
  assert.equal(captured1.redactedFieldNames.includes("passengerName"), true);
  assert.equal(
    JSON.stringify(captured1).includes("Jane Doe"),
    false
  );

  // External exposure is blocked for internal_evidence_only classification, but attribution is surfaced
  const exposure = redactor.renderForExternalExposure(captured1);
  assert.equal(exposure.allowed, false);
  assert.equal(exposure.reason, "redistribution_prohibited_by_license");
  assert.equal(exposure.attribution, "Flight data powered by FlightAware");
});

test("Issue #240: fails closed on unclassified sources and verification scanner catches undeclared source payloads in stored evidence", () => {
  const redactor = new ProviderPayloadClassifierAndRedactor();
  const now = 1_750_000_000_000;

  assert.throws(
    () =>
      redactor.captureAndRedactPayload({
        sourceId: "mystery_unclassified_vendor",
        feedId: "StablecoinDepeg",
        rawPayload: { price: 1.0 },
        capturedAtMs: now,
      }),
    /UNCLASSIFIED_SOURCE_BLOCKED/
  );

  redactor.registerSourcePolicy({
    sourceId: "coingecko",
    dataClassification: "public_redistributable",
    requiresAttribution: true,
    attributionText: "Data provided by CoinGecko",
    allowRawExternalExposure: true,
    piiFieldNames: [],
  });

  const validRecord = redactor.captureAndRedactPayload({
    sourceId: "coingecko",
    feedId: "StablecoinDepeg",
    rawPayload: { priceBps: 9995 },
    capturedAtMs: now,
  });

  const undeclaredStoredRecord: CapturedEvidencePayloadRecord = {
    ...validRecord,
    evidenceId: "ev_rogue_row",
    sourceId: "undeclared_vendor",
  };

  const scan = redactor.verifyStoredEvidenceCompliance([
    validRecord,
    undeclaredStoredRecord,
  ]);
  assert.equal(scan.compliant, false);
  assert.equal(scan.violations.length, 1);
  assert.match(scan.violations[0], /undeclared_vendor/);
});
