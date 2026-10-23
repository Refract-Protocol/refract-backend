import { AxiosInstance } from "axios";
import { getJsonWithEvidence } from "./http-json";
import {
  AdapterContext,
  AdapterSchemaError,
  MetricId,
  ObservationRequest,
  OracleSourceAdapter,
  RawObservation,
} from "./source-adapter";

interface ProtocolResponse {
  name?: unknown;
  tvl?: Array<{ date?: unknown; totalLiquidityUSD?: unknown }>;
}

/** DeFiLlama per-protocol TVL history: percent change over the trailing 24h. */
export class DefiLlamaAdapter implements OracleSourceAdapter {
  readonly id = "defillama";
  readonly displayName = "DeFiLlama";
  readonly trustTier = "live" as const;
  readonly metrics: readonly MetricId[] = ["protocol.tvl.change_24h_pct"];

  constructor(
    private readonly baseUrl: string,
    private readonly defaultSlug: string,
    private readonly http?: AxiosInstance,
  ) {}

  async fetch(request: ObservationRequest, ctx: AdapterContext): Promise<RawObservation> {
    if (request.metric !== "protocol.tvl.change_24h_pct") {
      throw new Error(`${this.id} does not provide ${request.metric}`);
    }
    const slug = request.subject ?? this.defaultSlug;
    const { data, evidence } = await getJsonWithEvidence<ProtocolResponse>(
      `${this.baseUrl}/protocol/${encodeURIComponent(slug)}`,
      undefined,
      ctx.timeoutMs,
      this.http,
    );

    const points = (data?.tvl ?? []).filter(
      (p): p is { date: number; totalLiquidityUSD: number } =>
        typeof p?.date === "number" && typeof p?.totalLiquidityUSD === "number",
    );
    if (points.length < 2) {
      throw new AdapterSchemaError(this.id, "insufficient TVL history");
    }

    const latest = points[points.length - 1];
    const dayAgoCutoff = latest.date - 86_400;
    let reference = points[0];
    for (const point of points) {
      if (point.date <= dayAgoCutoff) reference = point;
      else break;
    }
    if (reference.totalLiquidityUSD <= 0) {
      throw new AdapterSchemaError(this.id, "reference TVL is not positive");
    }

    const pctChange =
      ((latest.totalLiquidityUSD - reference.totalLiquidityUSD) / reference.totalLiquidityUSD) * 100;
    return {
      value: pctChange,
      observedAt: latest.date * 1000,
      evidence,
      context: { protocol: typeof data.name === "string" ? data.name : slug },
    };
  }
}
