import { Injectable } from "@nestjs/common";
import { OracleReading, Severity } from "./oracle-reading";

/**
 * OracleService aggregates real-world data for Refract trigger conditions.
 *
 * Data sources are still mocked here (ported as-is from the old
 * src/services/oracleMonitor.ts). A follow-up PR wires this up to real,
 * keyless public APIs:
 *  - StablecoinDepeg: CoinGecko simple price API
 *  - MarketCrash: Stellar Horizon testnet (XLM/USDC DEX data)
 *  - SmartContractRisk: DeFiLlama TVL/protocol API
 *  - FlightDelay: stays mocked — AviationStack requires a paid API key
 *    we don't have; see README for the TODO.
 */
@Injectable()
export class OracleService {
  async checkAll(): Promise<OracleReading[]> {
    return Promise.all([
      this.checkStablecoinDepeg(),
      this.checkMarketCrash(),
      this.checkSmartContractRisk(),
    ]);
  }

  async checkStablecoinDepeg(): Promise<OracleReading> {
    // In production: fetch from https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=usd
    const usdcPrice = 0.9998 + (Math.random() - 0.5) * 0.003;
    const threshold = 0.95; // 5% depeg
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
      message: `USDC price: $${usdcPrice.toFixed(4)} (${deviation > 0 ? "-" : "+"}${Math.abs(deviation).toFixed(3)}% from peg)`,
    };
  }

  async checkMarketCrash(): Promise<OracleReading> {
    // In production: fetch XLM/USDC 24h change from Stellar Horizon
    const change24h = -5.2 + (Math.random() - 0.5) * 10; // simulate ±10%
    const threshold = -30; // 30% crash triggers

    const severity: Severity =
      change24h < threshold   ? "triggered"
      : change24h < -20      ? "high"
      : change24h < -10      ? "medium"
      : "low";

    return {
      coverageType: "MarketCrash",
      type: "oracle_update",
      value: change24h,
      threshold,
      severity,
      message: `XLM 24h change: ${change24h.toFixed(2)}% (trigger at ${threshold}%)`,
    };
  }

  async checkSmartContractRisk(): Promise<OracleReading> {
    // In production: poll DeFiLlama hacks feed
    // https://defillama.com/hacks
    const hackDetected = Math.random() < 0.001; // 0.1% chance per minute

    return {
      coverageType: "SmartContractRisk",
      type: "oracle_update",
      value: hackDetected ? 1 : 0,
      threshold: 1,
      severity: hackDetected ? "triggered" : "low",
      message: hackDetected ? "⚠️ Smart contract exploit detected!" : "No exploits detected",
    };
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
      message: `Collateral ratio ${(collateralRatio * 100).toFixed(1)}% (shield triggers below ${(threshold * 100).toFixed(0)}%)`,
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
      message: `Flight ${flightNumber}: ${delayMinutes}m delay (trigger at ${threshold}m)`,
    };
  }
}
