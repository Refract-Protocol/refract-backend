import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OperatorAuthGuard,
  signOperatorBearerToken,
  type AuthMiddlewareConfig,
} from "./operatorAuth.ts";

describe("OperatorAuthGuard (Issue #235)", () => {
  const baseConfig: AuthMiddlewareConfig = {
    credentials: [
      {
        actorId: "viewer-alice",
        role: "viewer",
        secretKey: "viewer-secret-key-at-least-16-chars",
      },
      {
        actorId: "operator-bob",
        role: "operator",
        secretKey: "operator-secret-key-at-least-16-chars",
      },
      {
        actorId: "admin-carol",
        role: "approver_admin",
        secretKey: "admin-secret-key-at-least-16-chars!!",
      },
    ],
    routes: [
      {
        method: "GET",
        pathPattern: "/health",
        isPublic: true,
      },
      {
        method: "GET",
        pathPattern: "/api/trust/status",
        isPublic: true,
      },
      {
        method: "GET",
        pathPattern: "/api/admin/audit-logs",
        allowedRoles: ["viewer", "operator", "approver_admin"],
      },
      {
        method: "POST",
        pathPattern: "/api/operator/reconcile",
        allowedRoles: ["operator", "approver_admin"],
        rateLimitMaxRequests: 2,
        rateLimitWindowMs: 10_000,
      },
      {
        method: "POST",
        pathPattern: "/api/admin/trust-policy/override",
        allowedRoles: ["approver_admin"],
      },
    ],
  };

  it("allows public routes without credentials and blocks unauthenticated protected routes with 401", () => {
    const guard = new OperatorAuthGuard(baseConfig);

    const healthDecision = guard.authorize({
      method: "GET",
      path: "/health",
      headers: {},
    });
    assert.equal(healthDecision.allowed, true);
    assert.equal(healthDecision.statusCode, 200);

    const unauthDecision = guard.authorize({
      method: "POST",
      path: "/api/operator/reconcile",
      headers: {},
    });
    assert.equal(unauthDecision.allowed, false);
    assert.equal(unauthDecision.statusCode, 401);
    assert.equal(unauthDecision.errorCode, "UNAUTHORIZED");
  });

  it("enforces role-based access control (403 without leaking required roles) and propagates actor context", () => {
    const guard = new OperatorAuthGuard(baseConfig);
    const nowMs = 1_700_000_000_000;

    // Viewer tries to trigger operator reconciliation -> 403
    const viewerToken = signOperatorBearerToken(
      {
        actorId: "viewer-alice",
        iatMs: nowMs - 1_000,
        expMs: nowMs + 60_000,
      },
      "viewer-secret-key-at-least-16-chars"
    );

    const forbidden = guard.authorize({
      method: "POST",
      path: "/api/operator/reconcile",
      headers: { Authorization: `Bearer ${viewerToken}` },
      nowMs,
    });
    assert.equal(forbidden.allowed, false);
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.errorCode, "FORBIDDEN");
    assert.equal(forbidden.message?.includes("operator"), false);
    assert.equal(forbidden.message?.includes("approver_admin"), false);

    // Operator triggers reconciliation -> 200 with actorContext
    const operatorToken = signOperatorBearerToken(
      {
        actorId: "operator-bob",
        iatMs: nowMs - 1_000,
        expMs: nowMs + 60_000,
      },
      "operator-secret-key-at-least-16-chars"
    );

    const allowedOp = guard.authorize({
      method: "POST",
      path: "/api/operator/reconcile",
      headers: { Authorization: `Bearer ${operatorToken}` },
      nowMs,
    });
    assert.equal(allowedOp.allowed, true);
    assert.equal(allowedOp.statusCode, 200);
    assert.equal(allowedOp.actorContext?.actorId, "operator-bob");
    assert.equal(allowedOp.actorContext?.role, "operator");

    // Operator tries admin override -> 403
    const opOverride = guard.authorize({
      method: "POST",
      path: "/api/admin/trust-policy/override",
      headers: { Authorization: `Bearer ${operatorToken}` },
      nowMs,
    });
    assert.equal(opOverride.allowed, false);
    assert.equal(opOverride.statusCode, 403);

    // Approver admin via X-API-Key -> 200
    const adminOverride = guard.authorize({
      method: "POST",
      path: "/api/admin/trust-policy/override",
      headers: {
        "x-operator-id": "admin-carol",
        "x-api-key": "admin-secret-key-at-least-16-chars!!",
      },
      nowMs,
    });
    assert.equal(adminOverride.allowed, true);
    assert.equal(adminOverride.actorContext?.actorId, "admin-carol");
    assert.equal(adminOverride.actorContext?.role, "approver_admin");
  });

  it("rejects expired or tampered bearer tokens and enforces per-route rate limits (429)", () => {
    const guard = new OperatorAuthGuard(baseConfig);
    const nowMs = 1_700_000_000_000;

    const expiredToken = signOperatorBearerToken(
      {
        actorId: "operator-bob",
        iatMs: nowMs - 120_000,
        expMs: nowMs - 60_000,
      },
      "operator-secret-key-at-least-16-chars"
    );

    const expiredDecision = guard.authorize({
      method: "POST",
      path: "/api/operator/reconcile",
      headers: { Authorization: `Bearer ${expiredToken}` },
      nowMs,
    });
    assert.equal(expiredDecision.allowed, false);
    assert.equal(expiredDecision.statusCode, 401);

    const validToken = signOperatorBearerToken(
      {
        actorId: "operator-bob",
        iatMs: nowMs,
        expMs: nowMs + 60_000,
      },
      "operator-secret-key-at-least-16-chars"
    );

    // Rate limit on /api/operator/reconcile is 2 requests per 10,000ms
    const req1 = guard.authorize({
      method: "POST",
      path: "/api/operator/reconcile",
      headers: { Authorization: `Bearer ${validToken}` },
      nowMs: nowMs + 100,
    });
    const req2 = guard.authorize({
      method: "POST",
      path: "/api/operator/reconcile",
      headers: { Authorization: `Bearer ${validToken}` },
      nowMs: nowMs + 200,
    });
    const req3 = guard.authorize({
      method: "POST",
      path: "/api/operator/reconcile",
      headers: { Authorization: `Bearer ${validToken}` },
      nowMs: nowMs + 300,
    });

    assert.equal(req1.allowed, true);
    assert.equal(req2.allowed, true);
    assert.equal(req3.allowed, false);
    assert.equal(req3.statusCode, 429);
    assert.equal(req3.errorCode, "TOO_MANY_REQUESTS");
    assert.ok((req3.retryAfterMs ?? 0) > 0);
  });

  it("fails startup validation when protected routes exist without valid credentials", () => {
    assert.throws(() => {
      new OperatorAuthGuard({
        credentials: [],
        routes: [
          {
            method: "POST",
            pathPattern: "/api/admin/override",
            allowedRoles: ["approver_admin"],
          },
        ],
      });
    }, /startup validation failed/);
  });
});
