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

type SimplePrice = Record<string, { usd?: unknown; usd_24h_change?: unknown; last_updated_at?: unknown }>;

/** CoinGecko keyless simple-price API: USDC/USD price and XLM/USD 24h change. */
export class CoinGeckoAdapter implements OracleSourceAdapter {
  readonly id = "coingecko";
  readonly displayName = "CoinGecko";
  readonly trustTier = "live" as const;
  readonly metrics: readonly MetricId[] = ["usdc.usd.price", "xlm.usd.change_24h_pct"];

  constructor(
    private readonly baseUrl: string,
    private readonly http?: AxiosInstance,
  ) {}

  async fetch(request: ObservationRequest, ctx: AdapterContext): Promise<RawObservation> {
    switch (request.metric) {
      case "usdc.usd.price":
        return this.fetchCoin("usd-coin", "usd", false, ctx);
      case "xlm.usd.change_24h_pct":
        return this.fetchCoin("stellar", "usd_24h_change", true, ctx);
      default:
        throw new Error(`${this.id} does not provide ${request.metric}`);
    }
  }

  private async fetchCoin(
    coinId: string,
    field: "usd" | "usd_24h_change",
    include24h: boolean,
    ctx: AdapterContext,
  ): Promise<RawObservation> {
    const { data, evidence } = await getJsonWithEvidence<SimplePrice>(
      `${this.baseUrl}/simple/price`,
      {
        ids: coinId,
        vs_currencies: "usd",
        include_last_updated_at: true,
        ...(include24h ? { include_24hr_change: true } : {}),
      },
      ctx.timeoutMs,
      this.http,
    );
    const entry = data?.[coinId];
    const value = entry?.[field];
    if (typeof value !== "number") {
      throw new AdapterSchemaError(this.id, `${coinId}.${field} is not a number`);
    }
    const updated = entry?.last_updated_at;
    return {
      value,
      observedAt: typeof updated === "number" ? updated * 1000 : undefined,
      evidence,
    };
  }
}
