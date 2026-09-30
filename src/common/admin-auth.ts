import { timingSafeEqual } from "node:crypto";
import { Injectable, SetMetadata, UnauthorizedException, ServiceUnavailableException, type ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { AppConfig } from "../config/configuration";

const ADMIN_ONLY_METADATA = "admin-only";
const COMMUNITY_READ_METADATA = "community-read";

export type ApiKeyScope = "admin" | "community";

export interface CommunityApiKeyRecord {
  key: string;
  scope: "community";
  contact: string;
  rateLimitPerMinute: number;
  createdAt: string;
}

export function AdminOnly(): MethodDecorator & ClassDecorator {
  return SetMetadata(ADMIN_ONLY_METADATA, true);
}

/**
 * Marks a read-only endpoint as accessible to community-scoped API keys.
 * Community keys are never accepted on endpoints lacking this metadata, so
 * write/admin routes remain unreachable for community callers by construction.
 */
export function CommunityReadable(): MethodDecorator & ClassDecorator {
  return SetMetadata(COMMUNITY_READ_METADATA, true);
}

@Injectable()
export class AdminApiKeyGuard {
  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService<AppConfig, true>
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isAdminOnly = this.reflector.getAllAndOverride<boolean>(ADMIN_ONLY_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    const isCommunityReadable = this.reflector.getAllAndOverride<boolean>(COMMUNITY_READ_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!isAdminOnly && !isCommunityReadable) return true;

    const request = context.switchToHttp().getRequest<{
      get(name: string): string | undefined;
      apiKeyScope?: ApiKeyScope;
    }>();
    const providedKey = request.get("x-api-key");

    // Admin-only endpoints require the admin key and never accept community keys.
    if (isAdminOnly) {
      const configuredKey = this.configService.get("adminApiKey", { infer: true });
      if (!configuredKey) {
        throw new ServiceUnavailableException({
          code: "ADMIN_AUTH_NOT_CONFIGURED",
          error: "Admin authentication is not configured.",
        });
      }
      if (!providedKey || !this.keysMatch(providedKey, configuredKey)) {
        throw new UnauthorizedException({
          code: "ADMIN_AUTH_REQUIRED",
          error: "A valid admin API key is required.",
        });
      }
      request.apiKeyScope = "admin";
      return true;
    }

    // Community-readable endpoints accept the admin key or a valid community key.
    const configuredKey = this.configService.get("adminApiKey", { infer: true });
    if (configuredKey && providedKey && this.keysMatch(providedKey, configuredKey)) {
      request.apiKeyScope = "admin";
      return true;
    }

    const communityKey = providedKey ? this.findCommunityKey(providedKey) : undefined;
    if (!communityKey) {
      throw new UnauthorizedException({
        code: "COMMUNITY_AUTH_REQUIRED",
        error: "A valid community API key is required.",
      });
    }
    request.apiKeyScope = "community";
    return true;
  }

  private findCommunityKey(providedKey: string): CommunityApiKeyRecord | undefined {
    const keys = this.configService.get("communityApiKeys", { infer: true }) ?? [];
    return keys.find((record) => this.keysMatch(providedKey, record.key));
  }

  private keysMatch(providedKey: string, configuredKey: string): boolean {
    const provided = Buffer.from(providedKey);
    const configured = Buffer.from(configuredKey);
    return provided.length === configured.length && timingSafeEqual(provided, configured);
  }
}
