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

interface LedgersPage {
  _embedded?: { records?: Array<{ sequence?: unknown; closed_at?: unknown }> };
}

/**
 * Stellar Horizon: latest closed ledger. Horizon testnet has no usable XLM
 * price liquidity, so this supplies on-chain context for MarketCrash
 * readings rather than a price signal.
 */
export class HorizonAdapter implements OracleSourceAdapter {
  readonly id = "horizon";
  readonly displayName = "Stellar Horizon";
  readonly trustTier = "live" as const;
  readonly metrics: readonly MetricId[] = ["stellar.ledger.latest"];

  constructor(
    private readonly horizonUrl: string,
    private readonly http?: AxiosInstance,
  ) {}

  async fetch(request: ObservationRequest, ctx: AdapterContext): Promise<RawObservation> {
    if (request.metric !== "stellar.ledger.latest") {
      throw new Error(`${this.id} does not provide ${request.metric}`);
    }
    const { data, evidence } = await getJsonWithEvidence<LedgersPage>(
      `${this.horizonUrl}/ledgers`,
      { order: "desc", limit: 1 },
      ctx.timeoutMs,
      this.http,
    );
    const record = data?._embedded?.records?.[0];
    if (typeof record?.sequence !== "number") {
      throw new AdapterSchemaError(this.id, "ledgers[0].sequence is not a number");
    }
    const closedAt = typeof record.closed_at === "string" ? Date.parse(record.closed_at) : NaN;
    if (Number.isNaN(closedAt)) {
      throw new AdapterSchemaError(this.id, "ledgers[0].closed_at is not an ISO timestamp");
    }
    return {
      value: record.sequence,
      observedAt: closedAt,
      evidence,
      context: { closedAt: record.closed_at as string },
    };
  }
}
