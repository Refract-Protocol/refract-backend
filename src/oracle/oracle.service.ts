import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { CacheService, ORACLE_TTL } from "../cache/cache.service";
import { AppConfig } from "../config/configuration";
import { OracleReading, Severity } from "./oracle-reading";
import {
  CoinGeckoMarketV1,
  CoinGeckoStablecoinV1,
  DefiLlamaProtocolV1,
  HorizonLedgerV1,
  MAX_ORACLE_RESPONSE_BYTES,
  parseProviderResponse,
} from "./provider-response-schemas";

const CACHE_KEY_CHECK_ALL = "oracle:checkAll";
const COVERAGE_PROVIDER: Record<string, string> = {
  StablecoinDepeg: "coingecko",
  SmartContractRisk: "defillama",
  LiquidationShield: "mock",
  FlightDelay: "mock",
};

/**
 * OracleService aggregates real-world data for Refract trigger conditions.
 *
 * Three of the five checks call real, keyless public APIs:
 *  - StablecoinDepeg: CoinGecko simple-price API (USDC/USD)
 *  - MarketCrash: CoinGecko simple-price API (XLM/USD, 24h change), plus
 *    a genuine Stellar Horizon testnet call for chain context. Horizon's
 *    testnet XLM/USDC order books and trade_aggregations are effectively
 *    empty (near-zero real liquidity on testnet), so it isn't a usable
 *    24h-price source — CoinGecko is used for the actual price signal,
 *    and Horizon supplies the latest ledger as real on-chain context
 *    attached to the reading.
 *  - SmartContractRisk: DeFiLlama's per-protocol TVL history, checking
 *    for a >X% drop over the trailing 24h. `defiLlamaProtocolSlug`
 *    (default: "aave") stands in for a real "covered protocol" list
 *    until Refract defines one.
 *
 * Two checks stay mocked, honestly:
 *  - LiquidationShield: there's no public API for NEXUS Protocol
 *    liquidation events (NEXUS is a placeholder protocol in this repo).
 *  - FlightDelay: AviationStack requires a paid API key this project
 *    doesn't have. See README's "Oracle data sources" section.
 *
 * Caching
 * -------
 * checkAll() is the hot path: OracleController.getStatus() calls it on
 * every HTTP request, and ClaimService calls one of the individual checks
 * per active policy every 5 minutes.  A 55-second Redis cache (just under
 * the 60-second scheduler interval) is applied to checkAll() so repeated
 * HTTP requests and the scheduler share a single upstream round-trip per
 * cycle.  Individual check methods are NOT cached so OracleScheduler can
 * always broadcast a fresh reading.
 *
 * Every real check fails safe: if the upstream API errors or times out,
 * the check logs it and returns a "low" severity reading whose `value`
 * sits on the non-triggering side of its `threshold`, so a third-party
 * outage can never itself cause a false claim trigger.
 */
@Injectable()
export class OracleService {
  private readonly logger = new Logger(OracleService.name);
  private readonly timeoutMs: number;
  private readonly coingeckoBaseUrl: string;
  private readonly horizonUrl: string;
  private readonly defiLlamaBaseUrl: string;
  private readonly defiLlamaProtocolSlug: string;
  private readonly quotaPressure = new Map<string, number>();

  constructor(
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly cacheService: CacheService
  ) {
    const oracles = this.configService.get("oracles", { infer: true });
    this.timeoutMs = oracles.httpTimeoutMs;
    this.coingeckoBaseUrl = oracles.coingeckoBaseUrl;
    this.horizonUrl = oracles.horizonUrl;
    this.defiLlamaBaseUrl = oracles.defiLlamaBaseUrl;
    this.defiLlamaProtocolSlug = oracles.defiLlamaProtocolSlug;
  }

  /**
   * Returns all three live oracle readings.
   *
   * Results are served from Redis for up to ORACLE_TTL seconds (55 s) so
   * the HTTP endpoint, the scheduler, and ClaimService share a single set
   * of upstream calls per polling cycle rather than each issuing their own.
   * CoinGecko's keyless tier allows ~10-30 req/min; without this cache,
   * moderate REST traffic alone would exhaust that quota.
   */
  async checkAll(): Promise<OracleReading[]> {
    return this.cacheService.wrap(CACHE_KEY_CHECK_ALL, ORACLE_TTL, () =>
      this.runAllChecks()
    );
  }

  /**
   * Bypasses the cache and issues live upstream calls.  Called by
   * OracleScheduler so broadcasts always reflect the freshest data, and
   * the result is also written back into the cache as a side-effect of
   * checkAll()'s wrap() call on the next HTTP request.
   */
  async checkAllFresh(): Promise<OracleReading[]> {
    const readings = await this.runAllChecks();
    // Proactively refresh the cache so a subsequent HTTP call within the
    // same cycle gets the scheduler's fresh data immediately.
    await this.cacheService.set(CACHE_KEY_CHECK_ALL, readings, ORACLE_TTL);
    return readings;
  }

  private async runAllChecks(): Promise<OracleReading[]> {
    return Promise.all([
      this.checkStablecoinDepeg(),
      this.checkMarketCrash(),
      this.checkSmartContractRisk(),
    ]);
  }

  async checkStablecoinDepeg(): Promise<OracleReading> {
    const threshold = 0.95; // 5% depeg
    try {
      const { data, headers } = await axios.get<string>(
        `${this.coingeckoBaseUrl}/simple/price`,
        {
          ...this.requestConfig(),
          params: { ids: "usd-coin", vs_currencies: "usd" },
        }
      );
      this.recordQuotaPressure("coingecko", headers);
      const response = parseProviderResponse("CoinGecko", data, CoinGeckoStablecoinV1);
      const usdcPrice = response["usd-coin"].usd;
      const deviation = (1 - usdcPrice) * 100;

      const severity: Severity =
        usdcPrice < threshold ? "triggered"
        : usdcPrice < 0.98   ? "high"
        : usdcPrice < 0.99   ? "medium"
        : "low";

      return {
        coverageType: "StablecoinDepeg",
        type: "oracle_update",
        value: usdcPrice,
        threshold,
        severity,
        message: `USDC price: $${usdcPrice.toFixed(4)} (${deviation > 0 ? "-" : "+"}${Math.abs(deviation).toFixed(3)}% from peg) [CoinGecko]`,
      };
    } catch (err) {
      return this.degraded("StablecoinDepeg", threshold, "CoinGecko", err);
    }
  }

  async checkMarketCrash(): Promise<OracleReading> {
    const threshold = -30; // 30% crash triggers
    try {
      const priceRequest = axios.get<string>(
        `${this.coingeckoBaseUrl}/simple/price`,
        {
          ...this.requestConfig(),
          params: { ids: "stellar", vs_currencies: "usd", include_24hr_change: true },
        }
      );
      // Best-effort: attach real chain context, but never let a Horizon
      // hiccup fail the whole check — the price signal comes from CoinGecko.
      const ledgerRequest = axios
        .get<string>(
          `${this.horizonUrl}/ledgers`,
          {
            ...this.requestConfig(),
            params: { order: "desc", limit: 1 },
          }
        )
        .then(({ data, headers }) => {
          this.recordQuotaPressure("horizon", headers);
          return parseProviderResponse("Horizon", data, HorizonLedgerV1);
        })
        .catch((err: unknown) => {
          this.recordFailureQuotaPressure("horizon", err);
          this.logger.warn(
            "Horizon ledger context unavailable",
            err instanceof Error ? err.message : String(err),
          );
          return null;
        });

      const [priceRes, ledgerRes] = await Promise.all([priceRequest, ledgerRequest]);
      this.recordQuotaPressure("coingecko", priceRes.headers);
      const market = parseProviderResponse("CoinGecko", priceRes.data, CoinGeckoMarketV1);
      const change24h = market.stellar.usd_24h_change;
      const ledger = ledgerRes?._embedded.records[0];

      const severity: Severity =
        change24h < threshold   ? "triggered"
        : change24h < -20      ? "high"
        : change24h < -10      ? "medium"
        : "low";

      const chainContext = ledger
        ? ` [CoinGecko; Horizon testnet ledger #${ledger.sequence} @ ${ledger.closed_at}]`
        : " [CoinGecko]";

      return {
        coverageType: "MarketCrash",
        type: "oracle_update",
        value: change24h,
        threshold,
        severity,
        message: `XLM 24h change: ${change24h.toFixed(2)}% (trigger at ${threshold}%)${chainContext}`,
      };
    } catch (err) {
      return this.degraded("MarketCrash", threshold, "CoinGecko", err);
    }
  }

  async checkSmartContractRisk(): Promise<OracleReading> {
    const threshold = -50; // 50% TVL drop in 24h triggers
    try {
      const { data, headers } = await axios.get<string>(
        `${this.defiLlamaBaseUrl}/protocol/${this.defiLlamaProtocolSlug}`,
        this.requestConfig()
      );
      this.recordQuotaPressure("defillama", headers);
      const response = parseProviderResponse("DeFiLlama", data, DefiLlamaProtocolV1);
      const points = response.tvl;

      const latest = points[points.length - 1];
      const dayAgoCutoff = latest.date - 86_400;
      let reference = points[0];
      for (const point of points) {
        if (point.date <= dayAgoCutoff) reference = point;
        else break;
      }

      const pctChange =
        ((latest.totalLiquidityUSD - reference.totalLiquidityUSD) / reference.totalLiquidityUSD) * 100;

      const severity: Severity =
        pctChange < threshold ? "triggered"
        : pctChange < -25    ? "high"
        : pctChange < -10    ? "medium"
        : "low";

      return {
        coverageType: "SmartContractRisk",
        type: "oracle_update",
        value: pctChange,
        threshold,
        severity,
        message: `${response.name ?? this.defiLlamaProtocolSlug} TVL 24h change: ${pctChange.toFixed(2)}% (trigger at ${threshold}%) [DeFiLlama]`,
      };
    } catch (err) {
      return this.degraded("SmartContractRisk", threshold, "DeFiLlama", err);
    }
  }

  async checkLiquidationShield(): Promise<OracleReading> {
    // No public keyless API exists for this — it requires reading
    // liquidation events from the (hypothetical) NEXUS Protocol contract
    // on-chain. Stays mocked; ClaimService consumes this the same way it
    // would consume a real reading once that integration exists.
    // Spread is wide enough to actually cross the trigger threshold
    // sometimes — a ±0.05 spread around 0.92 never dips below 0.85.
    const collateralRatio = 0.92 + (Math.random() - 0.5) * 0.3;
    const threshold = 0.85; // shield triggers below 85% collateralization

    return {
      coverageType: "LiquidationShield",
      type: "oracle_update",
      value: collateralRatio,
      threshold,
      severity: collateralRatio < threshold ? "triggered" : "low",
      message: `Collateral ratio ${(collateralRatio * 100).toFixed(1)}% (shield triggers below ${(threshold * 100).toFixed(0)}%) [mocked — no NEXUS Protocol integration]`,
    };
  }

  async checkFlightDelay(flightNumber: string): Promise<OracleReading> {
    // TODO: AviationStack requires a paid API key we don't have — this
    // trigger type stays mocked until a keyless (or budgeted) flight-data
    // source is available. See README's "Oracle data sources" section.
    const delayMinutes = Math.floor(Math.random() * 300);
    const threshold = 120; // 2h delay triggers

    return {
      coverageType: "FlightDelay",
      type: "oracle_update",
      value: delayMinutes,
      threshold,
      severity: delayMinutes >= threshold ? "triggered" : "low",
      message: `Flight ${flightNumber}: ${delayMinutes}m delay (trigger at ${threshold}m) [mocked — AviationStack requires a paid key]`,
    };
  }

  /**
   * Fail-safe fallback for a real check whose upstream API errored or
   * timed out: logs the failure and returns a "low" severity reading.
   * All three real checks trigger on strict `value < threshold`, so
   * `value === threshold` is always non-triggering — an outage can
   * never itself cause a false claim trigger.
   */
  private degraded(coverageType: string, threshold: number, source: string, err: unknown): OracleReading {
    this.recordFailureQuotaPressure(source.toLowerCase(), err);
    this.logger.error(
      `${source} request failed for ${coverageType} check`,
      err instanceof Error ? err.message : String(err)
    );
    return {
      coverageType,
      type: "oracle_update",
      value: threshold,
      threshold,
      severity: "low",
      message: `${source} unavailable — degraded to a non-triggering reading`,
      degraded: true,
    };
  }

  private requestConfig() {
    return {
      timeout: this.timeoutMs,
      responseType: "text" as const,
      maxContentLength: MAX_ORACLE_RESPONSE_BYTES,
      transformResponse: [(body: unknown) => body],
    };
  }

  getQuotaPressure(coverageType: string): number {
    if (coverageType === "MarketCrash") {
      return Math.max(this.quotaPressure.get("coingecko") ?? 0, this.quotaPressure.get("horizon") ?? 0);
    }
    const provider = COVERAGE_PROVIDER[coverageType];
    return provider ? this.quotaPressure.get(provider) ?? 0 : 0;
  }

  private recordQuotaPressure(provider: string, headers: unknown, isRateLimited = false): void {
    if (typeof headers !== "object" || headers === null) {
      this.decreaseQuotaPressure(provider, isRateLimited);
      return;
    }
    const remaining = this.readHeader(headers, "x-ratelimit-remaining") ?? this.readHeader(headers, "ratelimit-remaining");
    const limit = this.readHeader(headers, "x-ratelimit-limit") ?? this.readHeader(headers, "ratelimit-limit");
    const retryAfter = Number(this.readHeader(headers, "retry-after") ?? 0);
    const remainingNumber = Number(remaining);
    const limitNumber = Number(limit);

    if (isRateLimited || retryAfter > 0) {
      this.quotaPressure.set(provider, 1);
    } else if (Number.isFinite(remainingNumber) && Number.isFinite(limitNumber) && limitNumber > 0) {
      this.quotaPressure.set(provider, Math.max(0, Math.min(1, 1 - remainingNumber / limitNumber)));
    } else {
      this.decreaseQuotaPressure(provider, false);
    }
  }

  private decreaseQuotaPressure(provider: string, isRateLimited: boolean): void {
    if (isRateLimited) {
      this.quotaPressure.set(provider, 1);
      return;
    }
    this.quotaPressure.set(provider, Math.max(0, (this.quotaPressure.get(provider) ?? 0) - 0.25));
  }

  private recordFailureQuotaPressure(provider: string, error: unknown): void {
    if (typeof error !== "object" || error === null || !("response" in error)) {
      return;
    }
    const response = error.response;
    if (typeof response !== "object" || response === null) {
      return;
    }
    const status = "status" in response ? Number(response.status) : undefined;
    const headers = "headers" in response ? response.headers : undefined;
    if (headers && typeof headers === "object") {
      this.recordQuotaPressure(provider, headers, status === 429);
    } else if (status === 429) {
      this.quotaPressure.set(provider, 1);
    }
  }

  private readHeader(headers: object, name: string): string | undefined {
    const value = Reflect.get(headers, name) ?? Reflect.get(headers, name.toUpperCase());
    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }
    if (typeof value === "object" && value !== null && "toString" in value) {
      return String(value);
    }
    return undefined;
  }
}
