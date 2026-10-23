import {
  CallHandler,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NestInterceptor,
  ServiceUnavailableException,
  SetMetadata,
  UnauthorizedException,
  applyDecorators,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { Observable, catchError, tap, throwError } from "rxjs";
import { FixedWindowLimiter, OperatorRateLimits } from "./actor-rate-limiter";
import { AuditContext, OracleAuditEvent, OracleAuditLog, runWithAuditContext } from "./oracle-audit";
import {
  OperatorAuthError,
  OperatorAuthenticator,
  OperatorIdentity,
  OraclePermission,
} from "./operator-identity";

export const ORACLE_OPERATOR_RATE_LIMITS = Symbol("ORACLE_OPERATOR_RATE_LIMITS");
export const ORACLE_OPERATOR_LIMITER = Symbol("ORACLE_OPERATOR_LIMITER");

const PERMISSION_KEY = "oracle:operator:permission";
const ACTION_KEY = "oracle:operator:action";

/**
 * Marks a handler as an operator endpoint that needs `permission`. The audit
 * trail records the call as `action`. The guard denies any handler without
 * this metadata, so a new route cannot ship unauthenticated by accident.
 */
export function OperatorRoute(permission: OraclePermission, action: string): MethodDecorator {
  return applyDecorators(SetMetadata(PERMISSION_KEY, permission), SetMetadata(ACTION_KEY, action));
}

export interface OperatorRequest extends Request {
  oracleOperator?: OperatorIdentity;
  oracleRequestId?: string;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function requestIdFor(req: OperatorRequest, res: Response): string {
  if (!req.oracleRequestId) {
    const header = req.get?.("x-request-id");
    req.oracleRequestId = header && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();
    res.setHeader?.("X-Request-Id", req.oracleRequestId);
  }
  return req.oracleRequestId;
}

function clientIp(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

function targetOf(req: Request): Record<string, string> {
  return { ...(req.params ?? {}) };
}

function baseEvent(
  req: OperatorRequest,
  res: Response,
  action: string
): Omit<OracleAuditEvent, "statusCode" | "outcome"> {
  const identity = req.oracleOperator;
  return {
    event: "oracle_operator_audit",
    timestamp: new Date().toISOString(),
    requestId: requestIdFor(req, res),
    action,
    method: req.method,
    route: req.route?.path ?? req.path ?? req.url,
    actor: {
      id: identity?.actor ?? "anonymous",
      ...(identity ? { role: identity.role, keyId: identity.keyId } : {}),
      ip: clientIp(req),
    },
    target: targetOf(req),
    changes: [],
  };
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The client-facing error text of an HttpException, else the error message. */
function failureReason(error: unknown): string {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    if (typeof body === "object" && body !== null && "error" in body) {
      const { error: text, issues } = body as { error: unknown; issues?: unknown };
      const codes = Array.isArray(issues)
        ? issues.map((i) => (typeof i === "object" && i !== null && "code" in i ? (i as { code: string }).code : String(i)))
        : [];
      return codes.length > 0 ? `${String(text)} (${codes.join(", ")})` : String(text);
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Authentication, authorization, and per-actor rate limiting for operator
 * oracle endpoints. Every rejection is written to the audit log.
 *
 * Order matters:
 *  1. Fail closed if the route has no permission metadata or no keys are configured.
 *  2. Refuse IPs over the failed-authentication budget before checking any credential.
 *  3. Authenticate. Every failure is a generic 401, and the reason goes to the audit log.
 *  4. Authorize the role against the route's permission (403).
 *  5. Rate-limit the authenticated actor, with separate read and write budgets (429).
 */
@Injectable()
export class OracleOperatorGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authenticator: OperatorAuthenticator,
    private readonly audit: OracleAuditLog,
    @Inject(ORACLE_OPERATOR_LIMITER) private readonly limiter: FixedWindowLimiter,
    @Inject(ORACLE_OPERATOR_RATE_LIMITS) private readonly limits: OperatorRateLimits
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const req = http.getRequest<OperatorRequest>();
    const res = http.getResponse<Response>();
    const permission = this.reflector.get<OraclePermission | undefined>(PERMISSION_KEY, context.getHandler());
    const action = this.reflector.get<string | undefined>(ACTION_KEY, context.getHandler()) ?? "unknown";

    const deny = (status: number, reason: string, error: HttpException): never => {
      this.audit.write({ ...baseEvent(req, res, action), statusCode: status, outcome: "denied", reason });
      throw error;
    };

    if (!permission) {
      deny(403, "route_without_permission", new ForbiddenException({ error: "Operator route is not configured" }));
    }
    if (!this.authenticator.configured) {
      deny(
        503,
        "operator_auth_not_configured",
        new ServiceUnavailableException({
          code: "OPERATOR_AUTH_NOT_CONFIGURED",
          error: "Operator authentication is not configured (ORACLE_OPERATOR_KEYS).",
        })
      );
    }

    const ip = clientIp(req);
    const failureKey = `auth-fail:${ip}`;
    const lockout = this.limiter.peek(failureKey, this.limits.authFailures);
    if (!lockout.allowed) {
      res.setHeader("Retry-After", String(lockout.retryAfterSeconds));
      deny(429, "auth_failure_lockout", new HttpException({ error: "Too many failed authentication attempts" }, 429));
    }

    let identity: OperatorIdentity;
    try {
      identity = this.authenticator.authenticate(req.get("authorization"));
    } catch (error) {
      if (!(error instanceof OperatorAuthError)) throw error;
      this.limiter.hit(failureKey, this.limits.authFailures);
      return deny(
        401,
        `${error.reason}${error.keyId ? `:${error.keyId}` : ""}`,
        new UnauthorizedException({ code: "OPERATOR_AUTH_REQUIRED", error: "A valid operator API key is required." })
      );
    }
    req.oracleOperator = identity;

    if (!identity.permissions.includes(permission as OraclePermission)) {
      deny(
        403,
        `missing_permission:${permission}`,
        new ForbiddenException({
          code: "OPERATOR_FORBIDDEN",
          error: `Role ${identity.role} lacks permission ${permission}.`,
        })
      );
    }

    const bucket = READ_METHODS.has(req.method.toUpperCase()) ? "read" : "write";
    const decision = this.limiter.hit(`actor:${identity.actor}:${bucket}`, this.limits[bucket]);
    res.setHeader("X-RateLimit-Limit", String(decision.limit));
    res.setHeader("X-RateLimit-Remaining", String(decision.remaining));
    if (!decision.allowed) {
      res.setHeader("Retry-After", String(decision.retryAfterSeconds));
      deny(
        429,
        `rate_limited:${bucket}`,
        new HttpException(
          { error: "Operator rate limit exceeded", retryAfter: decision.retryAfterSeconds },
          HttpStatus.TOO_MANY_REQUESTS
        )
      );
    }

    return true;
  }
}

/**
 * Runs the handler inside the operator's audit context and writes one audit
 * event per request. The event includes every before/after change the
 * handler recorded.
 */
@Injectable()
export class OracleAuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: OracleAuditLog
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<OperatorRequest>();
    const res = http.getResponse<Response>();
    const identity = req.oracleOperator;
    if (!identity) return next.handle();

    const action = this.reflector.get<string | undefined>(ACTION_KEY, context.getHandler()) ?? "unknown";
    const auditContext: AuditContext = {
      requestId: requestIdFor(req, res),
      actor: identity.actor,
      role: identity.role,
      keyId: identity.keyId,
      ip: clientIp(req),
      changes: [],
    };
    const write = (statusCode: number, outcome: "success" | "failure", reason?: string) =>
      this.audit.write({
        ...baseEvent(req, res, action),
        statusCode,
        outcome,
        ...(reason ? { reason } : {}),
        changes: auditContext.changes,
      });

    return new Observable((subscriber) =>
      runWithAuditContext(auditContext, () =>
        next
          .handle()
          .pipe(
            tap(() => write(res.statusCode, "success")),
            catchError((error: unknown) => {
              const status = error instanceof HttpException ? error.getStatus() : 500;
              write(status, "failure", failureReason(error));
              return throwError(() => error);
            })
          )
          .subscribe(subscriber)
      )
    );
  }
}
