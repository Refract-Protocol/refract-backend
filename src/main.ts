import { NestFactory } from '@nestjs/core';
import { Logger, INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';

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
  const app: INestApplication = await NestFactory.create(AppModule);

  // Let Nest propagate shutdown signals to every provider that implements
  // onApplicationShutdown / beforeApplicationShutdown (schedulers, DB pool,
  // Redis client, etc.).
  app.enableShutdownHooks();

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`Application listening on port ${port}`);

  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      logger.warn(`Received ${signal} while already shutting down; ignoring`);
      return;
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
      await app.close();
      clearTimeout(forceExitTimer);
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

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error during bootstrap', err);
  process.exit(1);
});
