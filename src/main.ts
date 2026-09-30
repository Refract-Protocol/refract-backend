import "reflect-metadata";
import helmet from "helmet";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { ValidationPipe } from "@nestjs/common";
import { WsAdapter } from "@nestjs/platform-ws";
import { AppModule } from "./app.module";
import { winstonLogger } from "./common/logger";
import { AppConfig } from "./config/configuration";

/**
 * Graceful shutdown sequence (issue #58):
 *
 *  1. A SIGTERM/SIGINT (or an explicit `app.close()`) triggers Nest's
 *     shutdown hooks. Readiness flips to not-ready first so load balancers
 *     drain traffic before the server stops accepting connections.
 *  2. The HTTP server stops accepting new connections; in-flight requests
 *     are allowed to finish.
 *  3. Schedulers observe the shutdown signal and refuse to start new runs.
 *  4. In-flight settlements are awaited up to the grace period. A submitted
 *     Soroban transaction cannot be cancelled, so if the grace period
 *     expires the pending transaction hash is persisted with a loud warning
 *     for reconciliation on restart.
 *  5. WebSocket clients receive a proper close frame (the WsAdapter shares
 *     the HTTP server, so a dropped socket would be indistinguishable from
 *     a network failure).
 *  6. The database pool, Redis client, and any other resource are closed.
 *
 * A hard timeout force-exits if graceful shutdown stalls, so a stuck
 * resource cannot block a deploy forever.
 */

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: winstonLogger,
  });

  const config = app.get(ConfigService<AppConfig, true>);

  // Trust the configured number of proxy hops so throttling (and any other
  // client-IP logic) sees the real caller via X-Forwarded-For instead of the
  // load balancer's address. Configured deliberately rather than implicitly.
  const trustProxy = config.get("trustProxy", { infer: true });
  if (trustProxy) {
    app.getHttpAdapter().getInstance().set("trust proxy", trustProxy);
  }

  app.use(helmet());
  app.enableCors({ origin: config.get("frontendUrl", { infer: true }) });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    })
  );
  // Use the plain `ws` protocol adapter (not Nest's default socket.io) so
  // the WebSocket wire format stays identical to the old raw `ws` server —
  // any client already speaking to the oracle feed keeps working unchanged.
  app.useWebSocketAdapter(new WsAdapter(app));

  // Enable Nest lifecycle hooks so OnModuleDestroy/OnApplicationShutdown
  // run on SIGTERM/SIGINT instead of the process dying immediately.
  app.enableShutdownHooks();

  const port = config.get("port", { infer: true });
  await app.listen(port);

  // Hard timeout: if graceful shutdown stalls, force-exit so a stuck
  // resource cannot block a deploy forever. The grace period is
  // configurable via SHUTDOWN_GRACE_MS (defaults to 30s, matching the
  // Soroban confirmation poll window).
  const graceMs = Number(process.env.SHUTDOWN_GRACE_MS ?? 30_000);
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    winstonLogger.warn(`Received ${signal}, starting graceful shutdown`);

    const forceExit = setTimeout(() => {
      winstonLogger.error(
        `Graceful shutdown exceeded ${graceMs}ms, forcing exit`
      );
      process.exit(1);
    }, graceMs);
    forceExit.unref();

    try {
      await app.close();
      clearTimeout(forceExit);
      winstonLogger.info("Graceful shutdown complete");
      process.exit(0);
    } catch (err) {
      winstonLogger.error("Error during graceful shutdown", err as Error);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

bootstrap();
