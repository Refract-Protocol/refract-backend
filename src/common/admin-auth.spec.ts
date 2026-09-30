import { ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { AppConfig } from "../config/configuration";
import { AdminApiKeyGuard } from "./admin-auth";

function buildContext(apiKey?: string) {
  return {
    getHandler: () => ({}),
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => ({ get: (name: string) => (name === "x-api-key" ? apiKey : undefined) }),
    }),
  };
}

function buildGuard(apiKey: string, protectedRoute = true) {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(protectedRoute) };
  const configService = { get: jest.fn().mockReturnValue(apiKey) };
  return new AdminApiKeyGuard(
    reflector as unknown as Reflector,
    configService as unknown as ConfigService<AppConfig, true>
  );
}

describe("AdminApiKeyGuard", () => {
  it("allows unprotected routes without requiring a key", () => {
    expect(buildGuard("", false).canActivate(buildContext() as never)).toBe(true);
  });

  it("fails closed when an admin route has no configured key", () => {
    expect(() => buildGuard("").canActivate(buildContext() as never)).toThrow(ServiceUnavailableException);
  });

  it("requires the configured key on protected routes", () => {
    const guard = buildGuard("configured-secret");
    expect(() => guard.canActivate(buildContext() as never)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(buildContext("incorrect-secret") as never)).toThrow(UnauthorizedException);
    expect(guard.canActivate(buildContext("configured-secret") as never)).toBe(true);
  });
});
