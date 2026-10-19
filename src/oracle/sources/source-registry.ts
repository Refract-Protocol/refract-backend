import { Logger } from "@nestjs/common";
import { OracleSourceAdapter } from "./source-adapter";

/** Builds an adapter for a configured source id, injecting fetch and clock. */
export type OracleSourceFactory = () => OracleSourceAdapter;

const logger = new Logger("SourceRegistry");

/**
 * Maps coverage type → ordered list of adapters.
 *
 * Built once at startup from `ORACLE_SOURCES`, a `;`-separated list of
 * `CoverageType=sourceId,sourceId` entries, e.g.
 *   ORACLE_SOURCES="StablecoinDepeg=coingecko,horizon;MarketCrash=defillama"
 *
 * Unknown source ids, adapters that do not support the requested coverage
 * type, and malformed entries are logged and skipped so a bad entry never
 * takes down startup for unrelated coverage types.
 */
export class SourceRegistry {
  private readonly byCoverageType: Map<string, OracleSourceAdapter[]>;

  constructor(byCoverageType: Map<string, OracleSourceAdapter[]> = new Map()) {
    this.byCoverageType = byCoverageType;
  }

  static fromConfig(
    config: string | undefined,
    factories: Record<string, OracleSourceFactory>,
  ): SourceRegistry {
    const byCoverageType = new Map<string, OracleSourceAdapter[]>();
    if (!config?.trim()) {
      return new SourceRegistry(byCoverageType);
    }

    for (const entry of config.split(";")) {
      const [coverageType, ids = ""] = entry.split("=").map((part) => part.trim());
      if (!coverageType || !ids) {
        logger.warn(`Ignoring malformed ORACLE_SOURCES entry "${entry.trim()}"`);
        continue;
      }

      const adapters: OracleSourceAdapter[] = [];
      for (const id of ids.split(",").map((part) => part.trim()).filter(Boolean)) {
        const factory = factories[id];
        if (!factory) {
          logger.warn(`Unknown oracle source "${id}" for ${coverageType}; skipping`);
          continue;
        }
        const adapter = factory();
        if (!adapter.supportedCoverageTypes.includes(coverageType)) {
          logger.warn(`Oracle source "${id}" does not support ${coverageType}; skipping`);
          continue;
        }
        adapters.push(adapter);
      }

      if (adapters.length > 0) {
        byCoverageType.set(coverageType, adapters);
      }
    }

    return new SourceRegistry(byCoverageType);
  }

  /** Ordered adapters for a coverage type; empty when none are configured. */
  getAdapters(coverageType: string): readonly OracleSourceAdapter[] {
    return this.byCoverageType.get(coverageType) ?? [];
  }
}
