import { test } from "node:test";
import assert from "node:assert/strict";
import { SourceReadingDeduplicator } from "./sourceReadingDeduplicator.ts";

test("SourceReadingDeduplicator collapses identical retries into one vote and flags conflicting same-window readings", () => {
  const dedup = new SourceReadingDeduplicator();

  const res = dedup.deduplicateWindowReadings([
    // 3 identical retries from src-1 -> should collapse to 1 vote
    { sourceId: "src-1", canonicalWindowTs: 60_000, payloadHash: "h1", normalizedValue: 100, receivedAtMs: 60_010 },
    { sourceId: "src-1", canonicalWindowTs: 60_000, payloadHash: "h1", normalizedValue: 100, receivedAtMs: 60_020 },
    { sourceId: "src-1", canonicalWindowTs: 60_000, payloadHash: "h1", normalizedValue: 100, receivedAtMs: 60_030 },
    // 1 clean reading from src-2
    { sourceId: "src-2", canonicalWindowTs: 60_000, payloadHash: "h2", normalizedValue: 101, receivedAtMs: 60_015 },
    // 2 conflicting readings from src-3 in the same window -> flagged and excluded
    { sourceId: "src-3", canonicalWindowTs: 60_000, payloadHash: "h3a", normalizedValue: 100, receivedAtMs: 60_012 },
    { sourceId: "src-3", canonicalWindowTs: 60_000, payloadHash: "h3b", normalizedValue: 150, receivedAtMs: 60_025 },
  ]);

  assert.equal(res.collapsedDuplicateCount, 2);
  assert.deepEqual(res.conflictingSources, ["src-3"]);
  assert.equal(res.deduplicatedReadings.length, 2);
  assert.deepEqual(
    res.deduplicatedReadings.map((r) => r.sourceId).sort(),
    ["src-1", "src-2"]
  );
});
