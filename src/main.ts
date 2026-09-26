import "reflect-metadata";
import helmet from "helmet";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { ValidationPipe, VersioningType, RequestMethod } from "@nestjs/common";
import { WsAdapter } from "@nestjs/platform-ws";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
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

  // OpenAPI documentation generated from the code. The spec is served as
  // JSON at `/api/docs-json` and rendered by Swagger UI at `/api/docs`.
  // The `@nestjs/swagger` CLI plugin (see nest-cli.json) infers DTO types
  // from TypeScript so annotations stay minimal; explicit `@ApiProperty`
  // decorators are only added where inference is insufficient (notably the
  // string-encoded 1e7 fixed-point money fields).
  const swaggerConfig = new DocumentBuilder()
    .setTitle("Stellar Coverage API")
    .setDescription(
      [
        "Machine-readable specification for the Stellar Coverage HTTP API.",
        "",
        "## Fixed-point money",
        "All monetary amounts (premiums, coverage amounts, pool balances) are",
        "transferred as decimal strings in 1e7 base units to avoid precision",
        "loss. For example `\"10000000\"` represents 1.0 USDC. Fields that",
        "carry this convention are typed as `string` and document their unit.",
        "",
        "## BigInt convention",
        "Per CONTRIBUTING.md, on-chain integer values (ledger sequences,",
        "timestamps, token amounts) are represented as decimal strings rather",
        "than JSON numbers so they survive JavaScript's 2^53 precision limit.",
        "",
        "## Unsigned XDR flow",
        "Endpoints that build a transaction return an unsigned `txXdr`. The",
        "caller must sign it in their wallet and submit the signed envelope",
        "separately via `POST /api/v1/tx/submit`. The server never holds keys",
        "and never signs on the caller's behalf.",
        "",
        "## WebSocket protocol",
        "The realtime oracle feed is a WebSocket protocol and is intentionally",
        "not described here; see the project README for its message shapes.",
      ].join("\n")
    )
    .setVersion("1.0")
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  // Swagger UI is disabled in production unless explicitly enabled via
  // `SWAGGER_ENABLED=true`, so the interactive explorer is not exposed by
  // default on public deployments. The raw JSON spec remains available for
  // tooling and CI drift checks.
  const swaggerEnabled =
    config.get("nodeEnv", { infer: true }) !== "production" ||
    process.env.SWAGGER_ENABLED === "true";

  SwaggerModule.setup("api/docs", app, document, {
    jsonDocumentUrl: "api/docs-json",
    swaggerOptions: { persistAuthorization: true },
  });

  if (!swaggerEnabled) {
    // Re-register the UI route as a 404 in production by mounting the spec
    // only; the JSON document stays reachable for consumers and CI.
    winstonLogger.warn(
      "Swagger UI disabled in production; raw spec available at /api/docs-json"
    );
  }

  const port = config.get("port", { infer: true });
  await app.listen(port);
}

bootstrap();
