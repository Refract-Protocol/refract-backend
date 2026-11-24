import { NestFactory } from '@nestjs/core';
import { Logger, INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';
import { isSandboxMode } from './config/configuration';
import { resolveProcessRole } from './runtime/process-role';
import { installGracefulShutdown } from './runtime/graceful-shutdown';

// Printed to stderr, never stdout, so it never mixes into the JSON a CLI
// script emits on stdout when SANDBOX_MODE=true.
function printSandboxBanner(): void {
  process.stderr.write(
    [
      '',
      '==============================================================',
      '  SANDBOX_MODE=true — oracle bootstrap skips the Postgres pool',
      '  and uses in-memory stores instead. Not for production use.',
      '==============================================================',
      '',
    ].join('\n') + '\n',
  );
}

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  if (isSandboxMode()) {
    printSandboxBanner();
  }

  // API entrypoint. With PROCESS_ROLE=api this process only serves reads and
  // the WebSocket feed; the payout pipeline runs in src/worker.ts. Unset
  // (= "all") keeps the old single-process behaviour for local development.
  const role = resolveProcessRole();
  if (role === 'worker') {
    throw new Error('PROCESS_ROLE=worker is for src/worker.ts; start the API with PROCESS_ROLE=api or all');
  }
  if (role === 'all') {
    logger.warn(
      'PROCESS_ROLE is not set: running the API and the payout pipeline in one process. ' +
        'In deployed environments set PROCESS_ROLE=api here and run the worker separately (npm run start:worker).',
    );
  }

  const app: INestApplication = await NestFactory.create(AppModule);

  // Let Nest propagate shutdown signals to every provider that implements
  // onApplicationShutdown / beforeApplicationShutdown (schedulers, DB pool,
  // Redis client, etc.).
  app.enableShutdownHooks();

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`Application listening on port ${port} (PROCESS_ROLE=${role})`);

  // app.close() stops accepting new connections, drains in-flight HTTP
  // requests, and invokes onApplicationShutdown on all providers so
  // schedulers finish their current run and pools close cleanly.
  installGracefulShutdown(() => app.close(), logger);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error during bootstrap', err);
  process.exit(1);
});
