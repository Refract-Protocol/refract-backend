import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CacheService } from "../cache/cache.service";
import { AppConfig } from "../config/configuration";
import { DbService } from "../db/db.service";
import { OracleTrustService } from "../oracle/oracle-trust.service";
import { SorobanRpcService } from "../stellar/soroban-rpc.service";

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @Optional() private readonly oracleTrust?: OracleTrustService,
    @Optional() private readonly rpcService?: SorobanRpcService,
    @Optional() private readonly dbService?: DbService,
    @Optional() private readonly database?: DbService,
    @Optional() private readonly cache?: CacheService,
    @Optional() private readonly configService?: ConfigService<AppConfig, true>,
  ) {}

  getLiveness(): { status: "ok" } {
    return { status: "ok" };
  }

  async getReadiness(): Promise<{
    ready: boolean;
    status: "ready" | "not_ready";
    checks: {
      sourcesReachable: boolean;
      quorumSatisfiable: boolean;
      rpcHealthy: boolean;
      evidenceStoreWritable: boolean;
      publisherConfigured: boolean;
    };
    trustMode: string;
    feeds: ReturnType<OracleTrustService["readiness"]>["feeds"];
    dependencies: { postgres: boolean; redis: boolean };
  }> {
    const feedReadiness = this.oracleTrust?.readiness();
    const infrastructure = await this.getInfrastructureReadiness();
    const [postgres, redis] = await Promise.all([
      Promise.resolve(this.database?.isAvailable() ?? this.dbService?.isAvailable() ?? false),
      this.cache ? this.cache.ping() : Promise.resolve(false),
    ]);
    const checks = {
      sourcesReachable: feedReadiness?.sourcesReachable ?? false,
      quorumSatisfiable: feedReadiness?.quorumSatisfiable ?? false,
      ...infrastructure.checks,
    };
    const ready = Object.values(checks).every(Boolean) && postgres && redis;
    return {
      ready,
      status: ready ? "ready" : "not_ready",
      checks,
      trustMode: feedReadiness?.trustMode ?? "strict",
      feeds: feedReadiness?.feeds ?? [],
      dependencies: { postgres, redis },
    };
  }

  async getInfrastructureReadiness(): Promise<{
    ready: boolean;
    checks: {
      rpcHealthy: boolean;
      evidenceStoreWritable: boolean;
      publisherConfigured: boolean;
    };
  }> {
    const feedReadiness = this.oracleTrust?.readiness();
    const [rpcHealthy, evidenceStoreWritable] = await Promise.all([
      this.checkRpc(),
      this.checkEvidenceStore(),
    ]);
    const checks = {
      rpcHealthy,
      evidenceStoreWritable,
      publisherConfigured: feedReadiness?.publisherConfigured ?? false,
    };
    return { ready: Object.values(checks).every(Boolean), checks };
  }

  async getDetail(): Promise<Record<string, unknown>> {
    const readiness = await this.getReadiness();
    const { depth: deadLetterQueueDepth, warnings } = await this.getDeadLetterStatus();
    return {
      status: readiness.status,
      trustMode: readiness.trustMode,
      dependencies: {
        ...readiness.checks,
        postgres: this.database?.isAvailable() ?? this.dbService?.isAvailable() ?? false,
        redis: this.cache ? this.cache.isConnected() : false,
      },
      feeds: readiness.feeds,
      deadLetterQueueDepth,
      warnings,
    };
  }

  /**
   * Counts rows in oracle_dead_letters awaiting replay and flags a warning
   * once the backlog exceeds the configured threshold. Returns depth -1
   * when no DB connection is available, so a reader can distinguish
   * "unknown" from "zero backlog" without a separate flag.
   */
  private async getDeadLetterStatus(): Promise<{ depth: number; warnings: string[] }> {
    const db = this.database ?? this.dbService;
    if (!db?.isAvailable()) return { depth: -1, warnings: [] };
    try {
      const { rows } = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM oracle_dead_letters WHERE replayed_at IS NULL`,
      );
      const depth = parseInt(rows[0]?.count ?? "0", 10);
      const threshold =
        this.configService?.get("oracleDeadLetterWarnThreshold", { infer: true }) ?? 50;
      const warnings =
        depth > threshold
          ? [`Oracle dead-letter backlog is ${depth} rows (warn threshold ${threshold}); run scripts/replay-oracle-dead-letters.ts`]
          : [];
      return { depth, warnings };
    } catch (error) {
      this.logger.warn(`Dead-letter depth probe failed: ${errorMessage(error)}`);
      return { depth: -1, warnings: [] };
    }
  }

  private async checkRpc(): Promise<boolean> {
    if (!this.rpcService) return false;
    try {
      await withTimeout(this.rpcService.server.getHealth(), 3_000, "Soroban RPC health probe timed out");
      return true;
    } catch (error) {
      this.logger.warn(`Soroban RPC readiness probe failed: ${errorMessage(error)}`);
      return false;
    }
  }

  private async checkEvidenceStore(): Promise<boolean> {
    if (!this.dbService?.isAvailable()) return false;
    try {
      await this.dbService.withClient(async (client) => {
        await client.query("BEGIN");
        try {
          await client.query(
            `INSERT INTO oracle_events (coverage_type, value, source, severity)
             VALUES ('stablecoin_depeg', 0, 'readiness_probe', 'low')`,
          );
          await client.query("ROLLBACK");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      });
      return true;
    } catch (error) {
      this.logger.warn(`Oracle evidence store readiness probe failed: ${errorMessage(error)}`);
      return false;
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
