import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CoinGeckoSourceAdapter,
  DeFiLlamaSourceAdapter,
  HorizonSourceAdapter,
  SourceRegistry,
} from "./sourceAdapterRegistry.ts";

test("CoinGecko, Horizon, and DeFiLlama adapters normalize readings and return structured errors on timeout, non-200, and malformed body", async () => {
  // CoinGecko success
  const cg = new CoinGeckoSourceAdapter(async () => ({
    status: 200,
    body: '{"price":0.9998,"observedAtMs":12345}',
  }));
  const cgRes = await cg.fetchReading({ coverageType: "USDC-DEPEG" });
  assert.equal(cgRes.ok, true);
  if (cgRes.ok) {
    assert.equal(cgRes.reading.value, 0.9998);
    assert.equal(cgRes.reading.sourceId, "coingecko");
  }

  // Horizon timeout -> structured TIMEOUT error
  const horizonTimeout = new HorizonSourceAdapter(async () => {
    throw new Error("Request timeout after 3000ms");
  });
  const hzRes = await horizonTimeout.fetchReading({
    coverageType: "USDC-DEPEG",
  });
  assert.equal(hzRes.ok, false);
  if (!hzRes.ok) {
    assert.equal(hzRes.error.code, "TIMEOUT");
  }

  // DeFiLlama non-200 -> structured HTTP_NON_200 error
  const dl502 = new DeFiLlamaSourceAdapter(async () => ({
    status: 502,
    body: "Bad Gateway",
  }));
  const dlRes = await dl502.fetchReading({
    coverageType: "PROTOCOL-TVL-DROP",
  });
  assert.equal(dlRes.ok, false);
  if (!dlRes.ok) {
    assert.equal(dlRes.error.code, "HTTP_NON_200");
  }

  // Malformed body -> structured MALFORMED_BODY error
  const cgMalformed = new CoinGeckoSourceAdapter(async () => ({
    status: 200,
    body: '{"price":"not-a-number"}',
  }));
  const malformedRes = await cgMalformed.fetchReading({
    coverageType: "USDC-DEPEG",
  });
  assert.equal(malformedRes.ok, false);
  if (!malformedRes.ok) {
    assert.equal(malformedRes.error.code, "MALFORMED_BODY");
  }
});

test("SourceRegistry resolves ordered adapters per coverage type and handles unknown or unconfigured coverage safely", () => {
  const registry = new SourceRegistry();
  const cg = new CoinGeckoSourceAdapter(async () => ({
    status: 200,
    body: '{"price":1.0}',
  }));
  const hz = new HorizonSourceAdapter(async () => ({
    status: 200,
    body: '{"midPrice":1.0}',
  }));

  registry.registerAdapter(cg);
  registry.registerAdapter(hz);
  registry.configureCoverageAdapters("USDC-DEPEG", [
    "coingecko",
    "missing-adapter",
    "horizon",
  ]);

  const resolved = registry.getAdaptersForCoverage("USDC-DEPEG");
  assert.deepEqual(
    resolved.map((a) => a.id),
    ["coingecko", "horizon"]
  );

  // Unknown coverage type returns empty list without crashing
  assert.deepEqual(registry.getAdaptersForCoverage("UNKNOWN-COVERAGE"), []);
});
