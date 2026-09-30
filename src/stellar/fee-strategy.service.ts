import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BASE_FEE } from "@stellar/stellar-sdk";
import { AppConfig, FeeProfileName } from "../config/configuration";
import { SorobanRpcService } from "./soroban-rpc.service";

export class FeeCeilingExceededError extends Error {
  readonly inclusionFee: string;
  readonly resourceFee: string;
  readonly totalFee: string;
  readonly ceiling: string;

  constructor(inclusionFee: bigint, resourceFee: bigint, ceiling: bigint) {
    const total = inclusionFee + resourceFee;
    super(
      `Estimated total fee ${total} stroops (inclusion ${inclusionFee} + resource ${resourceFee}) ` +
        `exceeds configured ceiling ${ceiling}. Raise FEE_CEILING_STROOPS or wait for fee market to cool.`
    );
    this.name = "FeeCeilingExceededError";
    this.inclusionFee = inclusionFee.toString();
    this.resourceFee = resourceFee.toString();
    this.totalFee = total.toString();
    this.ceiling = ceiling.toString();
  }
}

export type FeeProfile = FeeProfileName;

interface CachedFeeStats {
  fetchedAt: number;
  // Extreme percentile inclusion fees from getFeeStats, as strings (stroops).
  inclusionFee: {
    max: string;
    p99?: string;
    p90?: string;
    p10?: string;
    min: string;
    mode: string;
  };
}

/**
 * Computes the transaction inclusion fee from rpc.Server.getFeeStats() at a
 * configurable percentile, with multiplier / floor (BASE_FEE) / ceiling.
 *
 * Profiles:
 *  - moderate — user-signed builds (buy/provide/withdraw); user may resubmit
 *  - aggressive — relayer-signed settlement; payouts are time-sensitive
 *
 * Read-only simulations (onChainCoverageBounds, lockupExpiresAt) intentionally
 * keep BASE_FEE — they are never submitted, so fee market pressure is irrelevant.
 */
@Injectable()
export class FeeStrategyService {
  private readonly logger = new Logger(FeeStrategyService.name);
  private cache: CachedFeeStats | null = null;

  private readonly ttlMs: number;
  private readonly ceiling: bigint;
  private readonly profiles: AppConfig["fees"]["profiles"];

  constructor(
    private readonly rpcService: SorobanRpcService,
    configService: ConfigService<AppConfig, true>
  ) {
    const fees = configService.get("fees", { infer: true });
    this.ttlMs = fees.statsTtlMs;
    this.ceiling = BigInt(fees.ceilingStroops);
    this.profiles = fees.profiles;
  }

  /**
   * Returns the inclusion fee (stroops) as a string suitable for
   * TransactionBuilder's `fee` option. Degrades to BASE_FEE if getFeeStats
   * is unavailable so fee-endpoint trouble never blocks all transactions.
   */
  async estimateInclusionFee(profile: FeeProfile = "moderate"): Promise<string> {
    const stats = await this.getFeeStatsCached();
    if (!stats) {
      return BASE_FEE;
    }

    const cfg = this.profiles[profile];
    const raw = this.pickPercentile(stats, cfg.percentile);
    const multiplied = this.applyMultiplier(raw, cfg.multiplier);
    const floored = multiplied < BigInt(BASE_FEE) ? BigInt(BASE_FEE) : multiplied;
    if (floored > this.ceiling) {
      throw new FeeCeilingExceededError(floored, 0n, this.ceiling);
    }
    return floored.toString();
  }

  /**
   * After simulation/prepareTransaction, inspect minResourceFee and ensure
   * inclusion + resource stays under the ceiling. Logs the resource fee.
   */
  assertTotalUnderCeiling(inclusionFee: string | bigint, minResourceFee: string | bigint | undefined): void {
    const inclusion = typeof inclusionFee === "bigint" ? inclusionFee : BigInt(inclusionFee);
    const resource =
      minResourceFee === undefined || minResourceFee === null
        ? 0n
        : typeof minResourceFee === "bigint"
          ? minResourceFee
          : BigInt(minResourceFee);

    this.logger.log(`Simulation minResourceFee=${resource} stroops (inclusion=${inclusion})`);

    const total = inclusion + resource;
    if (total > this.ceiling) {
      throw new FeeCeilingExceededError(inclusion, resource, this.ceiling);
    }
  }

  /** Test/ops helper — clears the short-TTL fee-stats cache. */
  clearCache(): void {
    this.cache = null;
  }

  private pickPercentile(stats: CachedFeeStats, percentile: number): bigint {
    const fees = stats.inclusionFee;
    // Map configured percentile onto the buckets getFeeStats exposes.
    if (percentile >= 99 && fees.p99) return BigInt(fees.p99);
    if (percentile >= 90 && fees.p90) return BigInt(fees.p90);
    if (percentile >= 50) return BigInt(fees.mode || fees.min);
    if (fees.p10) return BigInt(fees.p10);
    return BigInt(fees.min || BASE_FEE);
  }

  private applyMultiplier(fee: bigint, multiplier: number): bigint {
    // Keep as integer stroops: multiplier is e.g. 1.2 → fee * 12 / 10.
    const scaled = Number(multiplier);
    if (!Number.isFinite(scaled) || scaled <= 0) return fee;
    const numerator = BigInt(Math.round(scaled * 1000));
    return (fee * numerator) / 1000n;
  }

  private async getFeeStatsCached(): Promise<CachedFeeStats | null> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < this.ttlMs) {
      return this.cache;
    }

    try {
      const stats = await this.rpcService.server.getFeeStats();
      const inclusion = stats.sorobanInclusionFee;
      if (!inclusion) {
        this.logger.warn("getFeeStats returned no inclusion-fee buckets; degrading to BASE_FEE");
        return null;
      }
      this.cache = {
        fetchedAt: now,
        inclusionFee: {
          max: String(inclusion.max),
          p99: inclusion.p99 !== undefined ? String(inclusion.p99) : undefined,
          p90: inclusion.p90 !== undefined ? String(inclusion.p90) : undefined,
          p10: inclusion.p10 !== undefined ? String(inclusion.p10) : undefined,
          min: String(inclusion.min),
          mode: String(inclusion.mode ?? inclusion.min),
        },
      };
      return this.cache;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`getFeeStats unavailable (${message}); degrading to BASE_FEE`);
      return null;
    }
  }
}
