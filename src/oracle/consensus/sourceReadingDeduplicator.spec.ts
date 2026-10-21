import { test } from "node:test";
import assert from "node:assert/strict";
import { SourceReadingDeduplicator } from "./sourceReadingDeduplicator.ts";

test("SourceReadingDeduplicator collapses identical retries into one vote and flags conflicting same-window readings", () => {
  const dedup = new SourceReadingDeduplicator();
  const hash = (value: string) =>
    SourceReadingDeduplicator.hashCanonicalPayload({ value });

  const res = dedup.deduplicateWindowReadings([
    // 3 identical retries from src-1 -> should collapse to 1 vote
    { sourceId: "src-1", canonicalWindowTs: 60_000, payloadHash: hash("1"), normalizedValue: 100, receivedAtMs: 60_010 },
    { sourceId: "src-1", canonicalWindowTs: 60_000, payloadHash: hash("1"), normalizedValue: 100, receivedAtMs: 60_020 },
    { sourceId: "src-1", canonicalWindowTs: 60_000, payloadHash: hash("1"), normalizedValue: 100, receivedAtMs: 60_030 },
    // 1 clean reading from src-2
    { sourceId: "src-2", canonicalWindowTs: 60_000, payloadHash: hash("2"), normalizedValue: 101, receivedAtMs: 60_015 },
    // 2 conflicting readings from src-3 in the same window -> flagged and excluded
    { sourceId: "src-3", canonicalWindowTs: 60_000, payloadHash: hash("3a"), normalizedValue: 100, receivedAtMs: 60_012 },
    { sourceId: "src-3", canonicalWindowTs: 60_000, payloadHash: hash("3b"), normalizedValue: 150, receivedAtMs: 60_025 },
  ]);

  assert.equal(res.collapsedDuplicateCount, 2);
  assert.deepEqual(res.conflictingSources, ["src-3"]);
  assert.equal(res.deduplicatedReadings.length, 2);
  assert.equal(
    res.evidence.filter((entry) => entry.reason === "conflicting_same_source_window").length,
    2,
  );
  assert.equal(
    res.evidence.filter((entry) => entry.reason === "duplicate_same_source_window").length,
    2,
  );
  assert.deepEqual(
    res.deduplicatedReadings.map((r) => r.sourceId).sort(),
    ["src-1", "src-2"]
  );
});

test("canonical payload hashes ignore object key order and observation windows normalize jitter", () => {
  assert.equal(
    SourceReadingDeduplicator.hashCanonicalPayload({ price: 1, metadata: { source: "a", unit: "USD" } }),
    SourceReadingDeduplicator.hashCanonicalPayload({ metadata: { unit: "USD", source: "a" }, price: 1 }),
  );
  assert.equal(
    SourceReadingDeduplicator.canonicalizeObservationTime(60_999, 60_000),
    60_000,
  );
  assert.throws(() => SourceReadingDeduplicator.canonicalizeObservationTime(-1, 1));
});
