import { createHmac, timingSafeEqual } from "node:crypto";

export type OperatorRole = "viewer" | "operator" | "approver_admin";

export interface ActorCredentialConfig {
  actorId: string;
  role: OperatorRole;
  secretKey: string;
  revoked?: boolean;
}

export interface RoutePolicy {
  method: string;
  pathPattern: string;
  isPublic?: boolean;
  allowedRoles?: OperatorRole[];
  rateLimitMaxRequests?: number;
  rateLimitWindowMs?: number;
}

export interface AuthMiddlewareConfig {
  credentials: ActorCredentialConfig[];
  routes: RoutePolicy[];
  defaultRateLimitMaxRequests?: number;
  defaultRateLimitWindowMs?: number;
  maxClockSkewMs?: number;
}

export interface AuthenticatedActorContext {
  actorId: string;
  role: OperatorRole;
  authenticatedAtMs: number;
  tokenExpiresAtMs?: number;
}

export interface IncomingAuthRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  clientIp?: string;
  nowMs?: number;
}

export interface AuthDecisionResult {
  allowed: boolean;
  statusCode: 200 | 401 | 403 | 429;
  errorCode?: "UNAUTHORIZED" | "FORBIDDEN" | "TOO_MANY_REQUESTS";
  message?: string;
  retryAfterMs?: number;
  actorContext?: AuthenticatedActorContext;
}

interface SignedBearerPayload {
  actorId: string;
  iatMs: number;
  expMs: number;
  nonce?: string;
}

function constantTimeCompareStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Compare bufA against itself to keep timing uniform before returning false
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function signOperatorBearerToken(
  payload: SignedBearerPayload,
  secretKey: string
): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secretKey)
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

export class OperatorAuthGuard {
  private readonly credentialsByActor = new Map<string, ActorCredentialConfig>();
  private readonly routes: RoutePolicy[];
  private readonly defaultRateLimitMax: number;
  private readonly defaultRateLimitWindowMs: number;
  private readonly maxClockSkewMs: number;
  private readonly requestBuckets = new Map<string, number[]>();

  constructor(config: AuthMiddlewareConfig) {
    const hasProtectedRoute = config.routes.some((r) => !r.isPublic);
    const activeCredentials = config.credentials.filter(
      (c) => !c.revoked && c.secretKey && c.secretKey.trim().length >= 16
    );

    if (hasProtectedRoute && activeCredentials.length === 0) {
      throw new Error(
        "OperatorAuthGuard startup validation failed: protected routes are registered but no valid operator credentials (>=16 chars) are configured"
      );
    }

    for (const cred of config.credentials) {
      this.credentialsByActor.set(cred.actorId, cred);
    }
    this.routes = config.routes;
    this.defaultRateLimitMax = config.defaultRateLimitMaxRequests ?? 30;
    this.defaultRateLimitWindowMs = config.defaultRateLimitWindowMs ?? 60_000;
    this.maxClockSkewMs = config.maxClockSkewMs ?? 5_000;
  }

  public authorize(req: IncomingAuthRequest): AuthDecisionResult {
    const nowMs = req.nowMs ?? Date.now();
    const matchedRoute = this.matchRoute(req.method, req.path);

    if (matchedRoute?.isPublic) {
      return {
        allowed: true,
        statusCode: 200,
      };
    }

    const authResult = this.authenticateRequest(req.headers, nowMs);
    if (!authResult.ok || !authResult.actorContext) {
      return {
        allowed: false,
        statusCode: 401,
        errorCode: "UNAUTHORIZED",
        message: "Authentication required or credentials invalid",
      };
    }

    const actor = authResult.actorContext;
    const allowedRoles = matchedRoute?.allowedRoles ?? ["approver_admin"];

    if (!allowedRoles.includes(actor.role)) {
      // Intentionally do NOT leak required roles in the error response
      return {
        allowed: false,
        statusCode: 403,
        errorCode: "FORBIDDEN",
        message: "Insufficient permissions for the requested resource",
      };
    }

    const maxRequests =
      matchedRoute?.rateLimitMaxRequests ?? this.defaultRateLimitMax;
    const windowMs =
      matchedRoute?.rateLimitWindowMs ?? this.defaultRateLimitWindowMs;
    const bucketKey = `${actor.actorId}:${req.method.toUpperCase()}:${matchedRoute?.pathPattern ?? req.path}`;

    const rateCheck = this.consumeRateLimit(bucketKey, maxRequests, windowMs, nowMs);
    if (!rateCheck.allowed) {
      return {
        allowed: false,
        statusCode: 429,
        errorCode: "TOO_MANY_REQUESTS",
        message: "Rate limit exceeded for sensitive endpoint",
        retryAfterMs: rateCheck.retryAfterMs,
      };
    }

    return {
      allowed: true,
      statusCode: 200,
      actorContext: actor,
    };
  }

  private authenticateRequest(
    headers: Record<string, string | undefined>,
    nowMs: number
  ): { ok: boolean; actorContext?: AuthenticatedActorContext } {
    const normalizedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === "string") {
        normalizedHeaders[k.toLowerCase()] = v.trim();
      }
    }

    const authHeader = normalizedHeaders["authorization"];
    if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
      const token = authHeader.slice(7).trim();
      return this.verifySignedBearerToken(token, nowMs);
    }

    const apiKeyActor = normalizedHeaders["x-operator-id"];
    const apiKeySecret = normalizedHeaders["x-api-key"];
    if (apiKeyActor && apiKeySecret) {
      const cred = this.credentialsByActor.get(apiKeyActor);
      if (!cred || cred.revoked) {
        return { ok: false };
      }
      if (!constantTimeCompareStrings(apiKeySecret, cred.secretKey)) {
        return { ok: false };
      }
      return {
        ok: true,
        actorContext: {
          actorId: cred.actorId,
          role: cred.role,
          authenticatedAtMs: nowMs,
        },
      };
    }

    return { ok: false };
  }

  private verifySignedBearerToken(
    token: string,
    nowMs: number
  ): { ok: boolean; actorContext?: AuthenticatedActorContext } {
    const parts = token.split(".");
    if (parts.length !== 2) {
      return { ok: false };
    }
    const [encodedPayload, signature] = parts;
    let payload: SignedBearerPayload;
    try {
      const rawJson = Buffer.from(encodedPayload, "base64url").toString("utf8");
      payload = JSON.parse(rawJson) as SignedBearerPayload;
    } catch {
      return { ok: false };
    }

    if (
      !payload ||
      typeof payload.actorId !== "string" ||
      typeof payload.iatMs !== "number" ||
      typeof payload.expMs !== "number"
    ) {
      return { ok: false };
    }

    const cred = this.credentialsByActor.get(payload.actorId);
    if (!cred || cred.revoked) {
      return { ok: false };
    }

    const expectedSignature = createHmac("sha256", cred.secretKey)
      .update(encodedPayload)
      .digest("base64url");

    if (!constantTimeCompareStrings(signature, expectedSignature)) {
      return { ok: false };
    }

    if (nowMs + this.maxClockSkewMs < payload.iatMs) {
      return { ok: false };
    }

    if (nowMs - this.maxClockSkewMs >= payload.expMs) {
      return { ok: false };
    }

    return {
      ok: true,
      actorContext: {
        actorId: cred.actorId,
        role: cred.role,
        authenticatedAtMs: nowMs,
        tokenExpiresAtMs: payload.expMs,
      },
    };
  }

  private matchRoute(method: string, path: string): RoutePolicy | undefined {
    const upperMethod = method.toUpperCase();
    for (const route of this.routes) {
      if (route.method.toUpperCase() !== upperMethod && route.method !== "*") {
        continue;
      }
      if (route.pathPattern === path) {
        return route;
      }
      if (
        route.pathPattern.endsWith("/*") &&
        path.startsWith(route.pathPattern.slice(0, -1))
      ) {
        return route;
      }
    }
    return undefined;
  }

  private consumeRateLimit(
    bucketKey: string,
    maxRequests: number,
    windowMs: number,
    nowMs: number
  ): { allowed: boolean; retryAfterMs?: number } {
    const existing = this.requestBuckets.get(bucketKey) ?? [];
    const windowStart = nowMs - windowMs;
    const activeTimestamps = existing.filter((ts) => ts > windowStart);

    if (activeTimestamps.length >= maxRequests) {
      const oldestInWindow = activeTimestamps[0]!;
      const retryAfterMs = Math.max(1, oldestInWindow + windowMs - nowMs);
      this.requestBuckets.set(bucketKey, activeTimestamps);
      return { allowed: false, retryAfterMs };
    }

    activeTimestamps.push(nowMs);
    this.requestBuckets.set(bucketKey, activeTimestamps);
    return { allowed: true };
  }
}
