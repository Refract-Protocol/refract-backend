import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { AppConfig } from "../config/configuration";
import { OracleReading, Severity } from "./oracle-reading";

interface DefiLlamaTvlPoint {
  date: number; // unix seconds
  totalLiquidityUSD: number;
}

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

  constructor(private readonly configService: ConfigService<AppConfig, true>) {
    const oracles = this.configService.get("oracles", { infer: true });
    this.timeoutMs = oracles.httpTimeoutMs;
    this.coingeckoBaseUrl = oracles.coingeckoBaseUrl;
    this.horizonUrl = oracles.horizonUrl;
    this.defiLlamaBaseUrl = oracles.defiLlamaBaseUrl;
    this.defiLlamaProtocolSlug = oracles.defiLlamaProtocolSlug;
  }

  async checkAll(): Promise<OracleReading[]> {
    return Promise.all([
      this.checkStablecoinDepeg(),
      this.checkMarketCrash(),
      this.checkSmartContractRisk(),
    ]);
  }

  async checkStablecoinDepeg(): Promise<OracleReading> {
    const threshold = 0.95; // 5% depeg
    try {
      const { data } = await axios.get<Record<string, { usd: number }>>(
        `${this.coingeckoBaseUrl}/simple/price`,
        { params: { ids: "usd-coin", vs_currencies: "usd" }, timeout: this.timeoutMs }
      );
      const usdcPrice = data["usd-coin"].usd;
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
      const priceRequest = axios.get<Record<string, { usd: number; usd_24h_change: number }>>(
        `${this.coingeckoBaseUrl}/simple/price`,
        {
          params: { ids: "stellar", vs_currencies: "usd", include_24hr_change: true },
          timeout: this.timeoutMs,
        }
      );
      // Best-effort: attach real chain context, but never let a Horizon
      // hiccup fail the whole check — the price signal comes from CoinGecko.
      const ledgerRequest = axios
        .get<{ _embedded: { records: Array<{ sequence: number; closed_at: string }> } }>(
          `${this.horizonUrl}/ledgers`,
          { params: { order: "desc", limit: 1 }, timeout: this.timeoutMs }
        )
        .catch(() => null);

      const [priceRes, ledgerRes] = await Promise.all([priceRequest, ledgerRequest]);
      const change24h = priceRes.data.stellar.usd_24h_change;
      const ledger = ledgerRes?.data?._embedded?.records?.[0];

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
      const { data } = await axios.get<{ name?: string; tvl?: DefiLlamaTvlPoint[] }>(
        `${this.defiLlamaBaseUrl}/protocol/${this.defiLlamaProtocolSlug}`,
        { timeout: this.timeoutMs }
      );
      const points = data.tvl ?? [];
      if (points.length < 2) throw new Error("DeFiLlama returned insufficient TVL history");

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
        message: `${data.name ?? this.defiLlamaProtocolSlug} TVL 24h change: ${pctChange.toFixed(2)}% (trigger at ${threshold}%) [DeFiLlama]`,
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
    const collateralRatio = 0.92 + (Math.random() - 0.5) * 0.1;
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
    };
  }
}
