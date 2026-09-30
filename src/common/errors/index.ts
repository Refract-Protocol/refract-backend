/**
 * Domain error hierarchy for the API.
 *
 * Every error carries a stable machine-readable `code` (see the catalog in
 * `docs/error-codes.md`) and an HTTP status so the global
 * `AllExceptionsFilter` can map it to the documented error envelope:
 *
 *   { error: { code, message, details?, correlationId, timestamp, path } }
 *
 * Status mapping:
 *   - validation            -> 400
 *   - not found             -> 404
 *   - auth                  -> 401 / 403
 *   - rate limit            -> 429
 *   - upstream RPC / 3rd    -> 502
 *   - dependency unavailable-> 503
 *   - everything else       -> 500
 */

export type ErrorDetails = Record<string, unknown>;

export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly status: number;
  readonly details?: ErrorDetails;

  constructor(message: string, details?: ErrorDetails) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 400 — malformed or semantically invalid input. */
export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_ERROR';
  readonly status = 400;
}

/** 404 — a requested resource does not exist. */
export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';
  readonly status = 404;
}

/** 401 — the caller is not authenticated. */
export class UnauthorizedError extends DomainError {
  readonly code = 'UNAUTHORIZED';
  readonly status = 401;
}

/** 403 — the caller is authenticated but not permitted. */
export class ForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly status = 403;
}

/** 429 — the caller exceeded a rate limit. */
export class RateLimitError extends DomainError {
  readonly code = 'RATE_LIMITED';
  readonly status = 429;
}

/** 502 — an upstream RPC or third-party service returned an invalid response. */
export class UpstreamError extends DomainError {
  readonly code = 'UPSTREAM_ERROR';
  readonly status = 502;
}

/** 503 — a required dependency is currently unavailable. */
export class DependencyUnavailableError extends DomainError {
  readonly code = 'DEPENDENCY_UNAVAILABLE';
  readonly status = 503;
}

/** 500 — an unexpected internal failure. */
export class InternalError extends DomainError {
  readonly code = 'INTERNAL_ERROR';
  readonly status = 500;
}
