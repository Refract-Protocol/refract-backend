import { Request, Response, NextFunction } from 'express';

/**
 * Rate limiting primitives.
 *
 * Two tiers are supported:
 *  - Anonymous callers are limited per client IP (the conservative default).
 *  - Identified API-key holders (e.g. community-scoped keys) are limited
 *    per key, with a more generous budget that encourages registered use
 *    over anonymous scraping.
 *
 * The limiter is intentionally scope-agnostic: it only needs a stable
 * identity string plus a budget. Scope enforcement (read-only community
 * keys, admin-only guards) lives in the auth layer, not here.
 */

export interface RateLimitOptions {
  /** Maximum number of requests allowed within the window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /**
   * Resolve the identity a request should be accounted against.
   * Defaults to the client IP for anonymous callers.
   */
  keyGenerator?: (req: Request) => string;
  /** Optional message returned when the limit is exceeded. */
  message?: string;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Default anonymous per-IP budget. Kept conservative so that registered,
 * per-key callers are clearly better off than anonymous scrapers.
 */
export const ANONYMOUS_RATE_LIMIT: RateLimitOptions = {
  max: 60,
  windowMs: 60_000,
};

/**
 * Default per-key budget for identified API-key holders (community scope).
 * More generous than the anonymous per-IP limit by design.
 */
export const API_KEY_RATE_LIMIT: RateLimitOptions = {
  max: 600,
  windowMs: 60_000,
};

/**
 * Extract the API key presented by a caller, if any. Accepts the common
 * `Authorization: Bearer <key>` and `X-API-Key: <key>` conventions so the
 * limiter can account identified callers per key rather than per IP.
 */
export function extractApiKey(req: Request): string | undefined {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header.trim().length > 0) {
    return header.trim();
  }

  const authorization = req.headers['authorization'];
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match && match[1].trim().length > 0) {
      return match[1].trim();
    }
  }

  return undefined;
}

/**
 * Default identity resolver: account identified API-key holders per key and
 * everyone else per client IP. This keeps anonymous limits distinct from
 * (and stricter than) per-key limits.
 */
export function defaultKeyGenerator(req: Request): string {
  const apiKey = extractApiKey(req);
  if (apiKey) {
    return `key:${apiKey}`;
  }
  return `ip:${req.ip ?? 'unknown'}`;
}

/**
 * Create an Express middleware enforcing the given rate-limit budget.
 * Buckets are tracked in-memory and keyed by the resolved identity.
 */
export function rateLimit(options: RateLimitOptions) {
  const { max, windowMs, keyGenerator = defaultKeyGenerator, message } = options;
  const buckets = new Map<string, Bucket>();

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();
    const identity = keyGenerator(req);

    let bucket = buckets.get(identity);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(identity, bucket);
    }

    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: 'Too Many Requests',
        message: message ?? 'Rate limit exceeded. Please retry later.',
      });
      return;
    }

    next();
  };
}

/**
 * Anonymous per-IP limiter. Applied to public read endpoints for callers
 * that do not present an API key.
 */
export const anonymousRateLimit = rateLimit(ANONYMOUS_RATE_LIMIT);

/**
 * Per-key limiter for identified API-key holders. More generous than the
 * anonymous per-IP budget, encouraging registered community integrations
 * over anonymous scraping. Scope enforcement (read-only community keys)
 * is handled by the auth guard, not by this limiter.
 */
export const apiKeyRateLimit = rateLimit(API_KEY_RATE_LIMIT);
