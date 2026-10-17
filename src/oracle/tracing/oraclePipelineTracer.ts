import { randomBytes } from "node:crypto";

export type OraclePipelineStage =
  | "source_fetch"
  | "schema_validation"
  | "reading_persistence"
  | "consensus_aggregation"
  | "evidence_write"
  | "soroban_simulation"
  | "soroban_publish"
  | "claim_settlement";

export interface OracleSpanAttributes {
  feedId?: string;
  sourceId?: string;
  decisionId?: string;
  quorumMet?: boolean;
  txHash?: string;
  errorType?: string;
}

export interface OracleTraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  stage: OraclePipelineStage;
  startedAtMs: number;
  endedAtMs?: number;
  status: "ok" | "error";
  attributes: OracleSpanAttributes;
}

export class OraclePipelineTracer {
  private readonly enabled: boolean;
  private readonly spans: OracleTraceSpan[] = [];

  constructor(enabled = true) {
    this.enabled = enabled;
  }

  public startTraceId(): string {
    return randomBytes(16).toString("hex");
  }

  public recordSpan(params: {
    traceId: string;
    parentSpanId?: string;
    stage: OraclePipelineStage;
    startedAtMs: number;
    endedAtMs: number;
    status: "ok" | "error";
    attributes: OracleSpanAttributes;
  }): OracleTraceSpan | null {
    if (!this.enabled) {
      return null;
    }

    const span: OracleTraceSpan = {
      traceId: params.traceId,
      spanId: randomBytes(8).toString("hex"),
      parentSpanId: params.parentSpanId,
      stage: params.stage,
      startedAtMs: params.startedAtMs,
      endedAtMs: params.endedAtMs,
      status: params.status,
      attributes: { ...params.attributes },
    };
    this.spans.push(span);
    return span;
  }

  public formatW3CTraceparent(traceId: string, spanId: string): string {
    return `00-${traceId}-${spanId}-01`;
  }

  public getTraceSpans(traceId: string): OracleTraceSpan[] {
    return this.spans.filter((s) => s.traceId === traceId);
  }
}
