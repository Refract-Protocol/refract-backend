import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LiveFlightDelayAdapter,
  type RawAviationProviderFlight,
} from "./flightDelay.ts";

describe("LiveFlightDelayAdapter (Issue #181)", () => {
  it("normalizes on-time, delayed, cancelled, and diverted flights, respects local airport timezone, and caches within TTL", async () => {
    let providerCalls = 0;
    const fixtures: Record<string, RawAviationProviderFlight> = {
      AA100: {
        flightIata: "AA100",
        departureAirportIata: "JFK",
        arrivalAirportIata: "LHR",
        scheduledArrivalIso: "2026-10-17T23:30:00Z",
        actualOrEstimatedArrivalIso: "2026-10-18T02:15:00Z", // 165m delay
        arrivalTimezoneOffsetMinutes: 60, // UTC+1 -> scheduled local arrival date is 2026-10-18
      },
      BA200: {
        flightIata: "BA200",
        departureAirportIata: "LHR",
        arrivalAirportIata: "JFK",
        scheduledArrivalIso: "2026-10-17T18:00:00Z",
        cancelled: true,
      },
      DL300: {
        flightIata: "DL300",
        departureAirportIata: "ATL",
        arrivalAirportIata: "MIA",
        scheduledArrivalIso: "2026-10-17T15:00:00Z",
        diverted: true,
      },
    };

    const adapter = new LiveFlightDelayAdapter({
      providerName: "FlightAwareAeroAPI",
      apiKey: "secret-aviation-api-key-123",
      enabled: true,
      payoutDelayThresholdMinutes: 120,
      cacheTtlMs: 30_000,
      fetchFlightFromProvider: async ({ flightIata }) => {
        providerCalls += 1;
        return fixtures[flightIata] ?? null;
      },
    });

    assert.equal(adapter.getCatalogMetadata().isMocked, false);

    const t0 = 1_700_000_000_000;
    // 1. Delayed flight (165m >= 120m threshold) + local timezone boundary (23:30 UTC + 60m = 2026-10-18)
    const delayed = await adapter.fetchFlightStatus("aa100", "2026-10-17", t0);
    assert.equal(delayed.status, "ok");
    if (delayed.status === "ok") {
      assert.equal(delayed.reading.operationalStatus, "delayed");
      assert.equal(delayed.reading.delayMinutes, 165);
      assert.equal(delayed.reading.exceedsPayoutThreshold, true);
      assert.equal(delayed.reading.scheduledArrivalDateLocal, "2026-10-18");
      assert.equal(delayed.reading.fromCache, false);
    }

    // Cached repeat call within 30s TTL does not hit upstream provider
    const cached = await adapter.fetchFlightStatus(
      "AA100",
      "2026-10-17",
      t0 + 5_000
    );
    assert.equal(cached.status, "ok");
    if (cached.status === "ok") {
      assert.equal(cached.reading.fromCache, true);
    }
    assert.equal(providerCalls, 1);

    // 2. Cancelled and diverted flights are distinguishable and trigger payout eligibility
    const cancelled = await adapter.fetchFlightStatus(
      "BA200",
      "2026-10-17",
      t0
    );
    assert.equal(cancelled.status, "ok");
    if (cancelled.status === "ok") {
      assert.equal(cancelled.reading.operationalStatus, "cancelled");
      assert.equal(cancelled.reading.exceedsPayoutThreshold, true);
    }

    const diverted = await adapter.fetchFlightStatus("DL300", "2026-10-17", t0);
    assert.equal(diverted.status, "ok");
    if (diverted.status === "ok") {
      assert.equal(diverted.reading.operationalStatus, "diverted");
      assert.equal(diverted.reading.exceedsPayoutThreshold, true);
    }

    // 3. Unknown flight number returns status: no_reading (reason: unknown_flight), NEVER zero delay
    const unknown = await adapter.fetchFlightStatus("ZZ999", "2026-10-17", t0);
    assert.equal(unknown.status, "no_reading");
    if (unknown.status === "no_reading") {
      assert.equal(unknown.reason, "unknown_flight");
    }
  });

  it("fails fast at startup when enabled without an API key and degrades cleanly on rate limits", async () => {
    assert.throws(() => {
      new LiveFlightDelayAdapter({
        providerName: "AeroDataBox",
        apiKey: undefined,
        enabled: true,
        fetchFlightFromProvider: async () => null,
      });
    }, /startup validation failed/);

    const rateLimitedAdapter = new LiveFlightDelayAdapter({
      providerName: "AeroDataBox",
      apiKey: "valid-api-key-9999",
      enabled: true,
      fetchFlightFromProvider: async () => {
        throw new Error("HTTP 429 rate limit exceeded");
      },
    });

    const res = await rateLimitedAdapter.fetchFlightStatus(
      "UA400",
      "2026-10-17"
    );
    assert.equal(res.status, "no_reading");
    if (res.status === "no_reading") {
      assert.equal(res.reason, "rate_limited");
    }
  });
});
