import { test } from "node:test";
import assert from "node:assert/strict";
import { OraclePipelineTracer } from "./oraclePipelineTracer.ts";

test("OraclePipelineTracer records linked spans across pipeline stages and supports zero-overhead opt-out", () => {
  const tracer = new OraclePipelineTracer(true);
  const traceId = tracer.startTraceId();

  const fetchSpan = tracer.recordSpan({
    traceId,
    stage: "source_fetch",
    startedAtMs: 1_000,
    endedAtMs: 1_120,
    status: "ok",
    attributes: { feedId: "XLM_USD", sourceId: "coingecko" },
  })!;

  const consensusSpan = tracer.recordSpan({
    traceId,
    parentSpanId: fetchSpan.spanId,
    stage: "consensus_aggregation",
    startedAtMs: 1_125,
    endedAtMs: 1_140,
    status: "ok",
    attributes: { feedId: "XLM_USD", decisionId: "dec-77", quorumMet: true },
  })!;

  const publishSpan = tracer.recordSpan({
    traceId,
    parentSpanId: consensusSpan.spanId,
    stage: "soroban_publish",
    startedAtMs: 1_145,
    endedAtMs: 1_450,
    status: "ok",
    attributes: { feedId: "XLM_USD", decisionId: "dec-77", txHash: "tx-999" },
  })!;

  const spans = tracer.getTraceSpans(traceId);
  assert.equal(spans.length, 3);
  assert.equal(consensusSpan.parentSpanId, fetchSpan.spanId);
  assert.equal(publishSpan.parentSpanId, consensusSpan.spanId);
  assert.ok(tracer.formatW3CTraceparent(traceId, publishSpan.spanId).startsWith(`00-${traceId}-`));

  // Opt-out disabled mode records nothing
  const disabledTracer = new OraclePipelineTracer(false);
  const noop = disabledTracer.recordSpan({
    traceId,
    stage: "source_fetch",
    startedAtMs: 1,
    endedAtMs: 2,
    status: "ok",
    attributes: {},
  });
  assert.equal(noop, null);
});
