import { Global, Logger, Module } from "@nestjs/common";
import Redis from "ioredis";
import { LeaderLock, LocalLeaderLock, RedisLeaderLock, RedisLockClient } from "./leader-lock";
import {
  loadOracleShutdownOptions,
  ORACLE_LEADER_LOCK,
  ORACLE_SHUTDOWN_OPTIONS,
  OraclePipelineLifecycle,
} from "./oracle-pipeline-lifecycle.service";

/**
 * ORACLE_LEADER_LOCK=redis turns on leader election for multi-replica
 * deployments. The lock has its own Redis connection, so the shared cache
 * client can close on its own schedule. Anything else (the default) means
 * one replica that always leads.
 */
export function createLeaderLock(env: NodeJS.ProcessEnv = process.env): LeaderLock {
  if ((env.ORACLE_LEADER_LOCK ?? "").trim().toLowerCase() !== "redis") {
    return new LocalLeaderLock();
  }
  const url = env.REDIS_URL?.trim() || "redis://localhost:6379";
  const client = new Redis(url, { maxRetriesPerRequest: 2 });
  client.on("error", (err) => new Logger("OracleLeaderLock").warn(`Redis error: ${err.message}`));
  return new RedisLeaderLock(
    client as unknown as RedisLockClient,
    env.ORACLE_LEADER_LOCK_KEY?.trim() || "refract:oracle:leader",
    Number(env.ORACLE_LEADER_LOCK_TTL_MS ?? 30_000),
  );
}

@Global()
@Module({
  providers: [
    { provide: ORACLE_LEADER_LOCK, useFactory: () => createLeaderLock() },
    { provide: ORACLE_SHUTDOWN_OPTIONS, useFactory: () => loadOracleShutdownOptions() },
    OraclePipelineLifecycle,
  ],
  exports: [OraclePipelineLifecycle],
})
export class OraclePipelineModule {}
