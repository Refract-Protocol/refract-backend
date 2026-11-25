import { randomUUID } from "crypto";
import { NextFunction, Request, Response } from "express";

/**
 * Attaches a correlation id to every request: reuses an incoming
 * `x-correlation-id` header when present, otherwise generates one. Set on
 * the request (read by AllExceptionsFilter) and echoed back on the response
 * so an operator can tie a client-visible error body to a server log line.
 */
export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers["x-correlation-id"];
  const correlationId = (typeof incoming === "string" && incoming.trim()) || randomUUID();
  (req as Request & { correlationId?: string }).correlationId = correlationId;
  res.setHeader("x-correlation-id", correlationId);
  next();
}
