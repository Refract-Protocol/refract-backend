import "reflect-metadata";
import helmet from "helmet";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { ValidationPipe, VersioningType } from "@nestjs/common";
import { WsAdapter } from "@nestjs/platform-ws";
import { AppModule } from "./app.module";
import { winstonLogger } from "./common/logger";
import { AppConfig } from "./config/configuration";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: winstonLogger,
  });

  const config = app.get(ConfigService<AppConfig, true>);

  app.use(helmet());
  app.enableCors({ origin: config.get("frontendUrl", { infer: true }) });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    })
  );
  // Version the HTTP API via Nest's built-in URI versioning instead of
  // hand-writing `api/v1/` into every controller path. Controllers declare
  // their version, so introducing a v2 or deprecating a route no longer
  // requires touching every path string. Health probes are excluded from
  // both the prefix and versioning so they keep hitting stable paths.
  app.setGlobalPrefix("api", {
    exclude: [{ path: "health", method: RequestMethod.GET }],
  });
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: "1",
  });
  // Use the plain `ws` protocol adapter (not Nest's default socket.io) so
  // the WebSocket wire format stays identical to the old raw `ws` server —
  // any client already speaking to the oracle feed keeps working unchanged.
  // The gateway is mounted at the server root and is unaffected by the HTTP
  // prefix/versioning above.
  app.useWebSocketAdapter(new WsAdapter(app));

  const port = config.get("port", { infer: true });
  await app.listen(port);
}

bootstrap();
