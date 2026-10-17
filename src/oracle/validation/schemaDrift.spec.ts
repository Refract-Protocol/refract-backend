import test from "node:test";
import assert from "node:assert/strict";
import {
  SchemaDriftMonitor,
  type SchemaValidationResult,
} from "./schemaDrift.ts";

test("Issue #279: valid payloads and optional extra fields pass without alerting and update lastKnownGoodSample", () => {
  const alerts: SchemaValidationResult[] = [];
  const monitor = new SchemaDriftMonitor({
    onBreakingAlert: (res) => alerts.push(res),
  });

  // CoinGecko payload with an extra optional field ("last_updated_at") must NOT trigger breaking or drift alerts
  const cgResult = monitor.inspect(
    "coingecko",
    {
      "usd-coin": {
        usd: 0.9998,
        last_updated_at: 1710000000,
      },
    },
    { nowMs: 1_000 }
  );
  assert.equal(cgResult.classification, "ok");
  assert.equal(cgResult.allowIngestion, true);
  assert.equal(cgResult.quarantined, false);
  assert.equal(alerts.length, 0);

  const report = monitor.getReport("coingecko");
  assert.ok(report?.lastKnownGoodSample?.includes("0.9998"));
  assert.equal(report?.breakingCount, 0);
});

test("Issue #279: breaking field rename or null/NaN value quarantines the source, blocks ingestion, and fires an alert while preserving lastKnownGoodSample", () => {
  const alerts: SchemaValidationResult[] = [];
  const monitor = new SchemaDriftMonitor({
    onBreakingAlert: (res) => alerts.push(res),
  });

  // First record a valid DeFiLlama payload
  monitor.inspect(
    "defillama",
    {
      tvl: [{ date: 1710000000, totalLiquidityUSD: 1_250_000_000 }],
    },
    { nowMs: 2_000 }
  );

  // Upstream renames totalLiquidityUSD -> liquidity_usd (silent breaking change)
  const broken = monitor.inspect(
    "defillama",
    {
      tvl: [{ date: 1710003600, liquidity_usd: 1_250_000_000 }],
      apiKey: "super-secret-token-value",
    },
    { nowMs: 3_000 }
  );

  assert.equal(broken.classification, "breaking");
  assert.equal(broken.allowIngestion, false);
  assert.equal(broken.quarantined, true);
  assert.equal(alerts.length, 1);

  const report = monitor.getReport("defillama")!;
  assert.equal(report.quarantined, true);
  assert.equal(report.breakingCount, 1);
  assert.ok(report.lastKnownGoodSample?.includes("1250000000"));
  assert.ok(report.lastOffendingSample?.includes("[REDACTED]"), "Secrets in captured samples must be redacted");

  // While quarantined, even a subsequent payload remains blocked until operator clears quarantine
  const whileQuarantined = monitor.inspect(
    "defillama",
    {
      tvl: [{ date: 1710007200, totalLiquidityUSD: 1_260_000_000 }],
    },
    { nowMs: 4_000 }
  );
  assert.equal(whileQuarantined.allowIngestion, false);
  assert.equal(whileQuarantined.quarantined, true);

  monitor.clearQuarantine("defillama");
  const afterClear = monitor.inspect(
    "defillama",
    {
      tvl: [{ date: 1710007200, totalLiquidityUSD: 1_260_000_000 }],
    },
    { nowMs: 5_000 }
  );
  assert.equal(afterClear.allowIngestion, true);
});

test("Issue #279: rate-limit/quota responses are classified as rate_limited rather than false-positive schema drift", () => {
  const alerts: SchemaValidationResult[] = [];
  const monitor = new SchemaDriftMonitor({
    onBreakingAlert: (res) => alerts.push(res),
  });

  const rateLimited = monitor.inspect(
    "coingecko",
    {
      status: {
        error_code: 429,
        error_message: "You've exceeded the Rate Limit. Please visit https://www.coingecko.com",
      },
    },
    { httpStatus: 429, nowMs: 10_000 }
  );

  assert.equal(rateLimited.classification, "rate_limited");
  assert.equal(rateLimited.quarantined, false);
  assert.equal(rateLimited.allowIngestion, false);
  assert.equal(alerts.length, 0);

  const report = monitor.getReport("coingecko")!;
  assert.equal(report.rateLimitedCount, 1);
  assert.equal(report.breakingCount, 0);
  assert.equal(report.quarantined, false);
});
