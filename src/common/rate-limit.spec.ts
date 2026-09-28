import { HttpException, HttpStatus } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RateLimitGuard } from "./rate-limit";

function buildContext(ip: string, route: string = "/api/v1/quotes") {
  const handler = {};
  const setHeader = jest.fn();
  return {
    context: {
      getHandler: () => handler,
      getClass: () => class {},
      switchToHttp: () => ({
        getRequest: () => ({ ip, method: "POST", path: route }),
        getResponse: () => ({ setHeader }),
      }),
    },
    setHeader,
  };
}

describe("RateLimitGuard", () => {
  it("allows the configured request count, then returns a retryable 429", () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue({ limit: 2, windowMs: 60_000 }) };
    const guard = new RateLimitGuard(reflector as unknown as Reflector);
    const { context, setHeader } = buildContext("192.0.2.1");

    expect(guard.canActivate(context as never)).toBe(true);
    expect(guard.canActivate(context as never)).toBe(true);
    try {
      guard.canActivate(context as never);
      throw new Error("Expected request to be rate limited");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect((error as HttpException).getResponse()).toMatchObject({
        code: "RATE_LIMIT_EXCEEDED",
        retryAfterSeconds: expect.any(Number),
      });
    }
    expect(setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
  });

  it("tracks routes and client IPs independently", () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue({ limit: 1, windowMs: 60_000 }) };
    const guard = new RateLimitGuard(reflector as unknown as Reflector);
    const firstClient = buildContext("192.0.2.1");
    const secondClient = buildContext("192.0.2.2");
    const secondRoute = buildContext("192.0.2.1", "/api/v1/policies/buy");

    expect(guard.canActivate(firstClient.context as never)).toBe(true);
    expect(guard.canActivate(secondClient.context as never)).toBe(true);
    expect(guard.canActivate(secondRoute.context as never)).toBe(true);
  });

  it("does not affect routes without rate-limit metadata", () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) };
    const guard = new RateLimitGuard(reflector as unknown as Reflector);

    expect(guard.canActivate(buildContext("192.0.2.1").context as never)).toBe(true);
  });
});
