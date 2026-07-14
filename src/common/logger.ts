import * as winston from "winston";
import { WinstonModule, utilities } from "nest-winston";

/**
 * Shared Winston instance, wired into Nest via `nest-winston` so
 * `Logger.log(...)` calls across the app (and Nest's own internal
 * lifecycle logs) go through the same formatter/transport as before the
 * NestJS migration — colorized, timestamped, single-line console output.
 */
export const winstonLogger = WinstonModule.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.ms(),
    utilities.format.nestLike("Refract", { colors: true, prettyPrint: true })
  ),
  transports: [new winston.transports.Console()],
});
