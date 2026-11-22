import { Injectable, Logger, Optional } from "@nestjs/common";
import { CacheService } from "../cache/cache.service";
import { DbService } from "../db/db.service";
import { OracleControlRegistry } from "../oracle/admin/oracle-control.registry";
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
    @Optional() private readonly controls?: OracleControlRegistry,
  ) {}

  getLiveness(): { status: "ok" } {
    return { status: "ok" };
  }

  async getReadiness(): Promise<{
    ready: boolean;
    status: "ready" | "degraded" | "not_ready";
    /** Names the active operator pause(s) when the oracle is paused; null otherwise. */
    reason: string | null;
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
    const dependenciesOk = Object.values(checks).every(Boolean) && postgres && redis;
    const paused = this.controls?.listFeeds().filter((feed) => feed.pause?.paused) ?? [];
    const reason =
      paused.length > 0
        ? `Oracle paused: ${paused.map((feed) => `${feed.definition.id} (${feed.pause?.reason ?? "no reason given"})`).join("; ")}`
        : null;
    const ready = dependenciesOk && reason === null;
    return {
      ready,
      status: ready ? "ready" : dependenciesOk ? "degraded" : "not_ready",
      reason,
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
    return {
      status: readiness.status,
      reason: readiness.reason,
      trustMode: readiness.trustMode,
      dependencies: {
        ...readiness.checks,
        postgres: this.database?.isAvailable() ?? this.dbService?.isAvailable() ?? false,
        redis: this.cache ? this.cache.isConnected() : false,
      },
      feeds: readiness.feeds,
    };
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
