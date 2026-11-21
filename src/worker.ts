import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { resolveProcessRole } from "./runtime/process-role";
import { installGracefulShutdown } from "./runtime/graceful-shutdown";
import { PipelineHeartbeat } from "./runtime/pipeline-heartbeat";
import { startWorkerHealthServer } from "./worker/worker-health.server";
import { closeHttpAgents } from "./oracle/adapters/http-json";

/**
 * Worker entrypoint: runs the payout pipeline (oracle polling, consensus,
 * on-chain publishing, claim settlement) with no HTTP API, so it can be
 * deployed, scaled and restarted independently of the API tier.
 *
 * Run exactly one worker per relayer key — the relayer's sequence numbers
 * are managed in-process (see RelayerAccountService).
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger("WorkerBootstrap");

  const configured = process.env.PROCESS_ROLE;
  if (configured && resolveProcessRole() !== "worker") {
    throw new Error(`worker.ts must run with PROCESS_ROLE=worker (got "${configured}")`);
  }
  process.env.PROCESS_ROLE = "worker";

  // Imported after PROCESS_ROLE is fixed so module factories see the role.
  const { WorkerModule } = await import("./worker/worker.module");
  const { MetricsService } = await import("./metrics/metrics.service");

  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();

  const heartbeat = app.get(PipelineHeartbeat);
  let metrics: InstanceType<typeof MetricsService> | undefined;
  try {
    metrics = app.get(MetricsService, { strict: false });
  } catch {
    metrics = undefined;
  }

  const port = Number(process.env.WORKER_HEALTH_PORT ?? 4002);
  const health = await startWorkerHealthServer(
    {
      heartbeat,
      metrics: metrics ? async () => ({ body: await metrics!.metrics(), contentType: metrics!.contentType }) : undefined,
    },
    port
  );
  logger.log(`Worker started; health and metrics on port ${port}`);

  installGracefulShutdown(async () => {
    await new Promise<void>((resolve) => health.close(() => resolve()));
    // Stops schedulers (ClaimScheduler waits for an in-flight settlement),
    // closes the reading bus and connection pools.
    await app.close();
    // Release the shared oracle keep-alive sockets.
    closeHttpAgents();
  }, logger);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error during worker bootstrap", err);
  process.exit(1);
});
