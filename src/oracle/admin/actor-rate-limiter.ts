/**
 * Fixed-window rate limiting keyed by an arbitrary identity string.
 *
 * Operator endpoints are limited per authenticated actor, not per IP, so one
 * operator behind a shared NAT cannot exhaust another's budget and a leaked
 * key cannot exceed its own budget by rotating IPs. Failed authentication is
 * limited per client IP, because there is no trusted identity yet.
 */

export interface RateLimitBudget {
  limit: number;
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window resets. */
  retryAfterSeconds: number;
}

interface Window {
  count: number;
  resetAt: number;
}

/** Above this many tracked identities, expired windows are swept on the next hit. */
const SWEEP_THRESHOLD = 10_000;

export class FixedWindowLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Counts a hit against `identity` and reports whether it is within budget. */
  hit(identity: string, budget: RateLimitBudget): RateLimitDecision {
    const window = this.current(identity, budget);
    window.count += 1;
    return this.decision(window, budget);
  }

  /** Reports the budget state without counting a hit. */
  peek(identity: string, budget: RateLimitBudget): RateLimitDecision {
    const window = this.windows.get(identity);
    if (!window || window.resetAt <= this.now()) {
      return { allowed: true, limit: budget.limit, remaining: budget.limit, retryAfterSeconds: 0 };
    }
    return this.decision({ ...window, count: window.count + 1 }, budget);
  }

  reset(identity: string): void {
    this.windows.delete(identity);
  }

  get size(): number {
    return this.windows.size;
  }

  private current(identity: string, budget: RateLimitBudget): Window {
    const now = this.now();
    if (this.windows.size > SWEEP_THRESHOLD) {
      for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
    }
    let window = this.windows.get(identity);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + budget.windowMs };
      this.windows.set(identity, window);
    }
    return window;
  }

  private decision(window: Window, budget: RateLimitBudget): RateLimitDecision {
    return {
      allowed: window.count <= budget.limit,
      limit: budget.limit,
      remaining: Math.max(0, budget.limit - window.count),
      retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - this.now()) / 1000)),
    };
  }
}

export interface OperatorRateLimits {
  /** Per-actor budget for read endpoints. */
  read: RateLimitBudget;
  /** Per-actor budget for mutating endpoints. */
  write: RateLimitBudget;
  /** Per-IP budget of failed authentication attempts before lockout. */
  authFailures: RateLimitBudget;
}

function intFromEnv(raw: string | undefined, fallback: number, min: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
}

export function operatorRateLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): OperatorRateLimits {
  return {
    read: { limit: intFromEnv(env.ORACLE_OPERATOR_READ_LIMIT_PER_MIN, 120, 1), windowMs: 60_000 },
    write: { limit: intFromEnv(env.ORACLE_OPERATOR_WRITE_LIMIT_PER_MIN, 20, 1), windowMs: 60_000 },
    authFailures: {
      limit: intFromEnv(env.ORACLE_OPERATOR_AUTH_FAILURE_LIMIT, 10, 1),
      windowMs: 15 * 60_000,
    },
  };
}
