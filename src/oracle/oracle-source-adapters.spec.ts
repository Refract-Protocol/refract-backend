import {
  captureProviderPayload,
  PROVIDER_SCHEMA_DEPRECATION_DAYS,
} from "./oracle-source-adapters";

describe("captureProviderPayload", () => {
  it("accepts additive provider fields by default and hashes only the normalized payload", () => {
    const captured = captureProviderPayload("coingecko", {
      "usd-coin": { usd: 0.99, provider_extension: "ignored" },
      request_id: "not-retained",
    });

    expect(captured.payload).toEqual({ "usd-coin": { usd: 0.99 } });
    expect(captured.adapter).toBe("coingecko");
    expect(captured.schemaVersion).toBe(1);
    expect(captured.attribution).toBe("CoinGecko");
    expect(captured.policy.rawPayloadStorage).toBe("transient_only");
    expect(captured.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects unexpected fields in strict mode, including nested flight identifiers", () => {
    expect(() =>
      captureProviderPayload(
        "aviationstack",
        { flight: { iata: "BA249", delay: 150, passenger_name: "must-not-be-kept" } },
        { strict: true },
      ),
    ).toThrow();
  });

  it("strips passenger-identifying fields and prohibits retaining flight payloads", () => {
    const captured = captureProviderPayload("aviationstack", {
      flight: { iata: "BA249", delay: 150, passenger_name: "must-not-be-kept" },
      passenger: { email: "must-not-be-kept@example.test" },
    });

    expect(captured.payload).toEqual({ flight: { iata: "BA249", delay: 150 } });
    expect(captured.policy).toMatchObject({
      sensitivity: "personal",
      rawPayloadStorage: "prohibited",
      publicApiPayload: "derived_only",
    });
    expect(JSON.stringify(captured)).not.toContain("must-not-be-kept");
  });

  it("normalizes legacy response envelopes during the 90-day deprecation window only", () => {
    const start = Date.parse("2026-10-20T00:00:00.000Z");
    const insideWindow = start + (PROVIDER_SCHEMA_DEPRECATION_DAYS - 1) * 86_400_000;
    const captured = captureProviderPayload(
      "coingecko",
      { data: { "usd-coin": { usd: 1 } } },
      { schemaVersion: 0, now: insideWindow },
    );
    expect(captured.schemaVersion).toBe(0);
    expect(captured.payload).toEqual({ "usd-coin": { usd: 1 } });

    expect(() =>
      captureProviderPayload(
        "coingecko",
        { data: { "usd-coin": { usd: 1 } } },
        { schemaVersion: 0, now: start + (PROVIDER_SCHEMA_DEPRECATION_DAYS + 1) * 86_400_000 },
      ),
    ).toThrow("passed its deprecation window");
  });
});
