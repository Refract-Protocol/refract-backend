import { NestFactory } from '@nestjs/core';
import { Logger, INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';
import {
  assertNetworkConsistency,
  NetworkConsistencyError,
  verifyNetworkLive,
} from './config/network-consistency';
import { assertOracleSandboxSafety } from './oracle/sandbox/oracle-sandbox.config';
import { OraclePipelineLifecycle } from './oracle/shutdown/oracle-pipeline-lifecycle.service';

/**
 * Hard upper bound on how long we wait for in-flight work (HTTP requests,
 * scheduler runs, connection-pool drains) to finish before forcing exit.
 * Prevents a stuck settlement from hanging the process forever.
 */
const SHUTDOWN_GRACE_PERIOD_MS = Number(
  process.env.SHUTDOWN_GRACE_PERIOD_MS ?? 30_000,
);

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  await assertDeploymentConfig(logger);
  const app: INestApplication = await NestFactory.create(AppModule);

  // Signals are handled below, not with app.enableShutdownHooks(). Using
  // both made Nest run app.close() twice on one SIGTERM. app.close() still
  // runs every provider's onModuleDestroy → beforeApplicationShutdown →
  // onApplicationShutdown hook. The oracle pipeline drains in the middle
  // phase (bounded by ORACLE_SHUTDOWN_DRAIN_MS, kept below the grace period
  // here); Postgres and Redis close in the last one.

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`Application listening on port ${port}`);

  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      // A second signal means the operator wants out now.
      logger.error(`Received ${signal} again during graceful shutdown; forcing exit`);
      process.exit(1);
    }
    shuttingDown = true;
    logger.log(
      `Received ${signal}; starting graceful shutdown (grace period ${SHUTDOWN_GRACE_PERIOD_MS}ms)`,
    );

    // Hard upper bound: if graceful shutdown does not complete in time, log
    // the forced-exit path and terminate so the orchestrator is not left
    // waiting on a stuck in-flight settlement.
    const forceExitTimer = setTimeout(() => {
      logger.error(
        `Graceful shutdown exceeded ${SHUTDOWN_GRACE_PERIOD_MS}ms; forcing exit`,
      );
      process.exit(1);
    }, SHUTDOWN_GRACE_PERIOD_MS);
    // Do not keep the event loop alive solely for this timer.
    forceExitTimer.unref();

    try {
      // app.close() stops accepting new connections, drains in-flight HTTP
      // requests, and invokes onApplicationShutdown on all providers so
      // schedulers finish their current run and pools close cleanly.
      let pipeline: OraclePipelineLifecycle | undefined;
      try {
        pipeline = app.get(OraclePipelineLifecycle, { strict: false });
      } catch {
        pipeline = undefined;
      }
      await app.close();
      clearTimeout(forceExitTimer);
      // Exit non-zero if the oracle drain gave up on in-flight work, so the
      // orchestrator records an unclean stop.
      const drain = pipeline?.lastDrainResult();
      if (drain && !drain.drained) {
        logger.error('Shutdown finished with abandoned oracle work; exiting non-zero');
        process.exit(1);
      }
      logger.log('Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      clearTimeout(forceExitTimer);
      logger.error(
        `Error during graceful shutdown: ${(err as Error).message}`,
        (err as Error).stack,
      );
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

/**
 * Runs before any module starts, so a misconfigured deployment never opens a
 * connection or publishes anything.
 *  - Every network-specific value must belong to the one selected network.
 *  - With STELLAR_VALIDATE_ONCHAIN=true, the RPC and Horizon endpoints must
 *    also report that network's passphrase.
 *  - A provider sandbox deployment must not hold a relayer key.
 */
async function assertDeploymentConfig(logger: Logger): Promise<void> {
  assertOracleSandboxSafety();
  const report = assertNetworkConsistency(process.env);
  report.warnings.forEach((w) => logger.warn(w));
  const resolved = report.resolved!;
  logger.log(`Stellar network: ${resolved.network}`);

  if ((process.env.STELLAR_VALIDATE_ONCHAIN ?? '').trim().toLowerCase() === 'true') {
    const live = await verifyNetworkLive(resolved, {
      timeoutMs: Number(process.env.STELLAR_VALIDATE_TIMEOUT_MS ?? 5_000),
    });
    live.unreachable.forEach((w) => logger.warn(w));
    if (live.mismatches.length > 0) {
      throw new NetworkConsistencyError(live.mismatches);
    }
  }
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error during bootstrap', err);
  process.exit(1);
});
