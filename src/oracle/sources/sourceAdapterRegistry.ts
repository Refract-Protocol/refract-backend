export interface NormalizedSourceReading {
  value: number;
  unit: string;
  observedAtMs: number;
  sourceId: string;
  rawPayload: string;
  confidence: number;
}

export interface SourceAdapterError {
  code: "TIMEOUT" | "HTTP_NON_200" | "MALFORMED_BODY" | "UNSUPPORTED_COVERAGE";
  sourceId: string;
  message: string;
}

export type SourceAdapterResult =
  | { ok: true; reading: NormalizedSourceReading }
  | { ok: false; error: SourceAdapterError };

export interface AdapterHttpResponse {
  status: number;
  body: string;
}

export type InjectableFetchFn = (
  url: string,
  timeoutMs: number
) => Promise<AdapterHttpResponse>;

export interface OracleSourceAdapter {
  readonly id: string;
  readonly supportedCoverageTypes: readonly string[];
  fetchReading(params: {
    coverageType: string;
    timeoutMs?: number;
    nowMs?: number;
  }): Promise<SourceAdapterResult>;
}

async function safeInvokeFetch(
  sourceId: string,
  url: string,
  timeoutMs: number,
  fetchFn: InjectableFetchFn
): Promise<{ ok: true; body: string } | { ok: false; error: SourceAdapterError }> {
  try {
    const res = await fetchFn(url, timeoutMs);
    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        error: {
          code: "HTTP_NON_200",
          sourceId,
          message: `HTTP ${res.status} from ${sourceId}`,
        },
      };
    }
    return { ok: true, body: res.body };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.toLowerCase().includes("timeout");
    return {
      ok: false,
      error: {
        code: isTimeout ? "TIMEOUT" : "HTTP_NON_200",
        sourceId,
        message: msg,
      },
    };
  }
}

export class CoinGeckoSourceAdapter implements OracleSourceAdapter {
  public readonly id = "coingecko";
  public readonly supportedCoverageTypes = ["USDC-DEPEG", "XLM-PRICE"] as const;
  private readonly fetchFn: InjectableFetchFn;

  constructor(fetchFn: InjectableFetchFn) {
    this.fetchFn = fetchFn;
  }

  public async fetchReading(params: {
    coverageType: string;
    timeoutMs?: number;
    nowMs?: number;
  }): Promise<SourceAdapterResult> {
    if (!this.supportedCoverageTypes.includes(params.coverageType)) {
      return {
        ok: false,
        error: {
          code: "UNSUPPORTED_COVERAGE",
          sourceId: this.id,
          message: `Unsupported coverage type '${params.coverageType}'`,
        },
      };
    }

    const res = await safeInvokeFetch(
      this.id,
      `https://api.coingecko.com/api/v3/simple/price?coverage=${params.coverageType}`,
      params.timeoutMs ?? 3_000,
      this.fetchFn
    );
    if (!res.ok) return res;

    try {
      const parsed = JSON.parse(res.body) as { price?: unknown; observedAtMs?: unknown };
      if (typeof parsed.price !== "number" || !Number.isFinite(parsed.price)) {
        throw new Error("Missing numeric price");
      }
      return {
        ok: true,
        reading: {
          value: parsed.price,
          unit: "USD",
          observedAtMs:
            typeof parsed.observedAtMs === "number"
              ? parsed.observedAtMs
              : (params.nowMs ?? Date.now()),
          sourceId: this.id,
          rawPayload: res.body,
          confidence: 0.95,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "MALFORMED_BODY",
          sourceId: this.id,
          message: err instanceof Error ? err.message : "Invalid JSON",
        },
      };
    }
  }
}

export class HorizonSourceAdapter implements OracleSourceAdapter {
  public readonly id = "horizon";
  public readonly supportedCoverageTypes = ["USDC-DEPEG", "VALIDATOR-SLASHER"] as const;
  private readonly fetchFn: InjectableFetchFn;

  constructor(fetchFn: InjectableFetchFn) {
    this.fetchFn = fetchFn;
  }

  public async fetchReading(params: {
    coverageType: string;
    timeoutMs?: number;
    nowMs?: number;
  }): Promise<SourceAdapterResult> {
    const res = await safeInvokeFetch(
      this.id,
      `https://horizon.stellar.org/order_book?coverage=${params.coverageType}`,
      params.timeoutMs ?? 3_000,
      this.fetchFn
    );
    if (!res.ok) return res;

    try {
      const parsed = JSON.parse(res.body) as { midPrice?: unknown; ledgerCloseMs?: unknown };
      if (typeof parsed.midPrice !== "number" || !Number.isFinite(parsed.midPrice)) {
        throw new Error("Missing numeric midPrice");
      }
      return {
        ok: true,
        reading: {
          value: parsed.midPrice,
          unit: "USD",
          observedAtMs:
            typeof parsed.ledgerCloseMs === "number"
              ? parsed.ledgerCloseMs
              : (params.nowMs ?? Date.now()),
          sourceId: this.id,
          rawPayload: res.body,
          confidence: 0.9,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "MALFORMED_BODY",
          sourceId: this.id,
          message: err instanceof Error ? err.message : "Invalid JSON",
        },
      };
    }
  }
}

export class DeFiLlamaSourceAdapter implements OracleSourceAdapter {
  public readonly id = "defillama";
  public readonly supportedCoverageTypes = ["PROTOCOL-TVL-DROP", "USDC-DEPEG"] as const;
  private readonly fetchFn: InjectableFetchFn;

  constructor(fetchFn: InjectableFetchFn) {
    this.fetchFn = fetchFn;
  }

  public async fetchReading(params: {
    coverageType: string;
    timeoutMs?: number;
    nowMs?: number;
  }): Promise<SourceAdapterResult> {
    const res = await safeInvokeFetch(
      this.id,
      `https://coins.llama.fi/prices/current?coverage=${params.coverageType}`,
      params.timeoutMs ?? 3_000,
      this.fetchFn
    );
    if (!res.ok) return res;

    try {
      const parsed = JSON.parse(res.body) as { value?: unknown; timestampMs?: unknown };
      if (typeof parsed.value !== "number" || !Number.isFinite(parsed.value)) {
        throw new Error("Missing numeric value");
      }
      return {
        ok: true,
        reading: {
          value: parsed.value,
          unit: "USD",
          observedAtMs:
            typeof parsed.timestampMs === "number"
              ? parsed.timestampMs
              : (params.nowMs ?? Date.now()),
          sourceId: this.id,
          rawPayload: res.body,
          confidence: 0.95,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "MALFORMED_BODY",
          sourceId: this.id,
          message: err instanceof Error ? err.message : "Invalid JSON",
        },
      };
    }
  }
}

export class SourceRegistry {
  private readonly adaptersById = new Map<string, OracleSourceAdapter>();
  private readonly coverageBindings = new Map<string, string[]>();

  public registerAdapter(adapter: OracleSourceAdapter): void {
    this.adaptersById.set(adapter.id, adapter);
  }

  public configureCoverageAdapters(
    coverageType: string,
    orderedAdapterIds: string[]
  ): void {
    this.coverageBindings.set(coverageType, [...orderedAdapterIds]);
  }

  /**
   * Resolves the ordered list of configured and registered adapters for a coverage type.
   * Missing or unknown coverage types return an empty list without crashing unrelated feeds.
   */
  public getAdaptersForCoverage(coverageType: string): OracleSourceAdapter[] {
    const ids = this.coverageBindings.get(coverageType) ?? [];
    const resolved: OracleSourceAdapter[] = [];
    for (const id of ids) {
      const adapter = this.adaptersById.get(id);
      if (adapter) {
        resolved.push(adapter);
      }
    }
    return resolved;
  }
}
