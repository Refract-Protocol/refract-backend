import { HttpException, HttpStatus, Injectable, SetMetadata, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

const RATE_LIMIT_METADATA = "api-rate-limit";
const MAX_BUCKETS = 20_000;

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export function RateLimit(limit: number, windowMs = 60_000): MethodDecorator {
  return SetMetadata(RATE_LIMIT_METADATA, { limit, windowMs });
}

@Injectable()
export class RateLimitGuard {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private checksSinceCleanup = 0;

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) return true;

    const request = context.switchToHttp().getRequest<{
      ip?: string;
      method: string;
      path: string;
    }>();
    const response = context.switchToHttp().getResponse<{ setHeader(name: string, value: string): void }>();
    const now = Date.now();
    const key = `${request.ip ?? "unknown"}:${request.method}:${request.path}`;
    const current = this.buckets.get(key);
    const bucket =
      !current || now >= current.resetAt
        ? { count: 1, resetAt: now + options.windowMs }
        : { count: current.count + 1, resetAt: current.resetAt };
    this.buckets.delete(key);
    this.buckets.set(key, bucket);

    this.checksSinceCleanup++;
    if (this.checksSinceCleanup >= 256 || this.buckets.size > MAX_BUCKETS) {
      this.removeExpiredBuckets(now);
      this.checksSinceCleanup = 0;
      while (this.buckets.size > MAX_BUCKETS) {
        const oldestKey = this.buckets.keys().next().value;
        if (oldestKey === undefined) break;
        this.buckets.delete(oldestKey);
      }
    }

    if (bucket.count > options.limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      response.setHeader("Retry-After", String(retryAfterSeconds));
      throw new HttpException(
        {
          code: "RATE_LIMIT_EXCEEDED",
          error: "Too many requests. Please try again later.",
          retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
    return true;
  }

  private removeExpiredBuckets(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key);
    }
  }
}
