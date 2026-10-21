import { Injectable, Logger } from "@nestjs/common";
import { MetricId, SourceObservation } from "./adapters/source-adapter";
import { ObservationResult, OracleSourceRegistry } from "./adapters/source-registry";
import { OracleReading, Severity } from "./oracle-reading";

/** Readings are reused for this long so HTTP traffic shares one upstream round-trip per cycle. */
const SNAPSHOT_TTL_MS = 55_000;

/**
 * OracleService turns source observations into coverage-type readings.
 *
 * All live data — CoinGecko (USDC price, XLM 24h change), Stellar Horizon
 * (latest ledger, as chain context) and DeFiLlama (protocol TVL change) —
 * comes through {@link OracleSourceRegistry}. There are no bespoke
 * fetch-and-parse blocks here: canonicalization, freshness, quarantine,
 * evidence capture and metrics are applied by the registry, identically for
 * every source.
 *
 * Every live check fails safe: if no source returns a usable observation,
 * the check returns a degraded "low" reading whose value sits on the
 * non-triggering side of its threshold.
 *
 * LiquidationShield and FlightDelay remain mocked (no keyless upstream
 * exists); they are flagged in their message and never carry observations.
 */
@Injectable()
export class OracleService {
  private readonly logger = new Logger(OracleService.name);
  private snapshot: { at: number; readings: OracleReading[] } | null = null;

  constructor(private readonly registry: OracleSourceRegistry) {}

  /** All live readings, served from a short-lived snapshot. */
  async checkAll(): Promise<OracleReading[]> {
    if (this.snapshot && Date.now() - this.snapshot.at < SNAPSHOT_TTL_MS) {
      return this.snapshot.readings;
    }
    return this.checkAllFresh();
  }

  /** Bypasses the snapshot and observes every source now. */
  async checkAllFresh(): Promise<OracleReading[]> {
    const readings = await Promise.all([
      this.checkStablecoinDepeg(),
      this.checkMarketCrash(),
      this.checkSmartContractRisk(),
    ]);
    this.snapshot = { at: Date.now(), readings };
    return readings;
  }

  /** Scheduler entry point. */
  async refreshPrices(): Promise<OracleReading[]> {
    return this.checkAllFresh();
  }

  async checkStablecoinDepeg(): Promise<OracleReading> {
    const threshold = 0.95; // 5% depeg
    const obs = await this.firstLive("usdc.usd.price");
    if (!obs.observation) return this.degraded("StablecoinDepeg", threshold, obs.failures);

    const price = obs.observation.value;
    const deviation = (1 - price) * 100;
    const severity: Severity =
      price < threshold ? "triggered" : price < 0.98 ? "high" : price < 0.99 ? "medium" : "low";

    return this.reading("StablecoinDepeg", price, threshold, severity, [obs.observation],
      `USDC price: $${price.toFixed(4)} (${deviation > 0 ? "-" : "+"}${Math.abs(deviation).toFixed(3)}% from peg)`);
  }

  async checkMarketCrash(): Promise<OracleReading> {
    const threshold = -30; // 30% crash triggers
    const [price, ledger] = await Promise.all([
      this.firstLive("xlm.usd.change_24h_pct"),
      // Chain context is best-effort: a Horizon failure never fails the check.
      this.firstLive("stellar.ledger.latest"),
    ]);
    if (!price.observation) return this.degraded("MarketCrash", threshold, price.failures);

    const change = price.observation.value;
    const severity: Severity =
      change < threshold ? "triggered" : change < -20 ? "high" : change < -10 ? "medium" : "low";
    const observations = ledger.observation ? [price.observation, ledger.observation] : [price.observation];
    const chain = ledger.observation
      ? ` ledger #${ledger.observation.value} @ ${new Date(ledger.observation.observedAt).toISOString()}`
      : "";

    return this.reading("MarketCrash", change, threshold, severity, observations,
      `XLM 24h change: ${change.toFixed(2)}% (trigger at ${threshold}%)${chain}`);
  }

  async checkSmartContractRisk(subject?: string): Promise<OracleReading> {
    const threshold = -50; // 50% TVL drop in 24h triggers
    const obs = await this.firstLive("protocol.tvl.change_24h_pct", subject);
    if (!obs.observation) return this.degraded("SmartContractRisk", threshold, obs.failures);

    const change = obs.observation.value;
    const severity: Severity =
      change < threshold ? "triggered" : change < -25 ? "high" : change < -10 ? "medium" : "low";
    const name = obs.observation.context?.protocol ?? obs.observation.subject ?? "protocol";

    return this.reading("SmartContractRisk", change, threshold, severity, [obs.observation],
      `${name} TVL 24h change: ${change.toFixed(2)}% (trigger at ${threshold}%)`);
  }

  async checkLiquidationShield(): Promise<OracleReading> {
    // No public keyless API exists for NEXUS Protocol liquidation events.
    const collateralRatio = 0.92 + (Math.random() - 0.5) * 0.3;
    const threshold = 0.85;
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
    // AviationStack requires a paid key; stays mocked.
    const delayMinutes = Math.floor(Math.random() * 300);
    const threshold = 120;
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
   * First successful live observation for a metric. Cross-source
   * aggregation is the consensus layer's job; this keeps the
   * informational readings simple.
   */
  private async firstLive(
    metric: MetricId,
    subject?: string,
  ): Promise<{ observation?: SourceObservation; failures: ObservationResult[] }> {
    const results = await this.registry.observe({ metric, subject });
    const ok = results.find(
      (r): r is Extract<ObservationResult, { ok: true }> => r.ok && r.observation.trustTier === "live",
    );
    return { observation: ok?.observation, failures: results.filter((r) => !r.ok) };
  }

  private reading(
    coverageType: string,
    value: number,
    threshold: number,
    severity: Severity,
    observations: SourceObservation[],
    text: string,
  ): OracleReading {
    const sources = [...new Set(observations.map((o) => o.sourceId))];
    return {
      coverageType,
      type: "oracle_update",
      value,
      threshold,
      severity,
      message: `${text} [${sources.join("; ")}]`,
      sources,
      observations,
    };
  }

  /**
   * Fail-safe fallback: all checks trigger on strict `value < threshold`, so
   * `value === threshold` is always non-triggering.
   */
  private degraded(coverageType: string, threshold: number, failures: ObservationResult[]): OracleReading {
    const detail = failures
      .map((f) => (f.ok ? "" : `${f.sourceId}: ${f.reason}`))
      .filter(Boolean)
      .join(", ") || "no source registered";
    this.logger.error(`${coverageType} check degraded — ${detail}`);
    return {
      coverageType,
      type: "oracle_update",
      value: threshold,
      threshold,
      severity: "low",
      message: `Oracle sources unavailable (${detail}) — degraded to a non-triggering reading`,
      degraded: true,
      sources: [],
      observations: [],
    };
  }
}
