import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Request, Response } from "express";
import { DomainError, ErrorDetails } from "../errors/domain-errors";

/**
 * Global exception filter (issue #60).
 *
 * Produces exactly one error envelope for every HTTP failure:
 *
 *   { error: { code, message, details?, correlationId, timestamp, path } }
 *
 * Status mapping:
 *   - DomainError subclasses carry their own status/code.
 *   - Nest HttpExceptions keep their status; their body is normalized.
 *   - Anything else becomes a 500 with a generic message; the full stack is
 *     logged server-side against the correlation id and never sent to the
 *     client.
 */

/** Documented error-code catalog. */
export const ERROR_CODES = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  DEPENDENCY_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
} as const;

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: ErrorDetails;
    correlationId: string;
    timestamp: string;
    path: string;
  };
}

/**
 * BigInt is not JSON-serializable; convert it (and nested values) to a safe
 * representation so `details` never throws during serialization.
 */
function toSerializable(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toSerializable);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toSerializable(v);
    }
    return out;
  }
  return value;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const correlationId =
      (request.headers["x-correlation-id"] as string | undefined) ??
      (request as Request & { correlationId?: string }).correlationId ??
      "unknown";
    const path = request.url;

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = "INTERNAL_ERROR";
    let message = "Internal server error";
    let details: ErrorDetails | undefined;

    if (exception instanceof DomainError) {
      status = exception.status;
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === "string") {
        message = body;
      } else if (body && typeof body === "object") {
        const b = body as Record<string, unknown>;
        // Normalize Nest's ValidationPipe shape ({ message: string[] })
        // and the legacy { error: "..." } shape into one envelope.
        if (Array.isArray(b.message)) {
          message = "Validation failed";
          details = { messages: b.message };
          code = "VALIDATION_ERROR";
        } else if (typeof b.message === "string") {
          message = b.message;
        } else if (typeof b.error === "string") {
          message = b.error;
        }
        if (b.details && typeof b.details === "object") {
          details = b.details as ErrorDetails;
        }
      }
      code = codeForStatus(status, code);
    } else {
      // Unhandled: log the full stack server-side, return a generic message.
      const err = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(
        `Unhandled exception [${correlationId}] ${request.method} ${path}: ${err.message}`,
        err.stack
      );
    }

    const envelope: ErrorEnvelope = {
      error: {
        code,
        message,
        ...(details ? { details: toSerializable(details) as ErrorDetails } : {}),
        correlationId,
        timestamp: new Date().toISOString(),
        path,
      },
    };

    response.status(status).json(envelope);
  }
}

function codeForStatus(status: number, fallback: string): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return "VALIDATION_ERROR";
    case HttpStatus.UNAUTHORIZED:
      return "UNAUTHORIZED";
    case HttpStatus.FORBIDDEN:
      return "FORBIDDEN";
    case HttpStatus.NOT_FOUND:
      return "NOT_FOUND";
    case HttpStatus.TOO_MANY_REQUESTS:
      return "RATE_LIMITED";
    case HttpStatus.BAD_GATEWAY:
      return "UPSTREAM_ERROR";
    case HttpStatus.SERVICE_UNAVAILABLE:
      return "DEPENDENCY_UNAVAILABLE";
    default:
      return fallback;
  }
}
