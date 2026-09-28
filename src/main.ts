import "reflect-metadata";
import express, { ErrorRequestHandler } from "express";
import helmet from "helmet";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { ValidationPipe } from "@nestjs/common";
import { WsAdapter } from "@nestjs/platform-ws";
import { AppModule } from "./app.module";
import { winstonLogger } from "./common/logger";
import { AppConfig } from "./config/configuration";
import { jsonBodyDepthLimit, MAX_REQUEST_BODY_SIZE } from "./common/request-body-limits.middleware";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: winstonLogger,
    bodyParser: false,
  });

  const config = app.get(ConfigService<AppConfig, true>);

  app.use(helmet());
  app.use(express.json({ limit: MAX_REQUEST_BODY_SIZE }));
  app.use(express.urlencoded({ limit: MAX_REQUEST_BODY_SIZE, extended: false, parameterLimit: 100 }));
  app.use(jsonBodyDepthLimit);
  app.use(((error, _request, response, next) => {
    const parserError = error as { type?: string; status?: number };
    if (parserError.type === "entity.too.large") {
      response.status(413).json({ statusCode: 413, message: "Request body exceeds the maximum size" });
      return;
    }
    if (parserError.type === "entity.parse.failed" || parserError.status === 400) {
      response.status(400).json({ statusCode: 400, message: "Malformed request body" });
      return;
    }
    next(error);
  }) as ErrorRequestHandler);
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

  const port = config.get("port", { infer: true });
  await app.listen(port);
}

bootstrap();
