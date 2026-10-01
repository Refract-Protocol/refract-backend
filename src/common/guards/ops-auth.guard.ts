import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../../config/configuration";

/**
 * API-key scopes. `admin` keys carry full ops capability; `community` keys are
 * read-only and must never be accepted on write/admin endpoints.
 */
export type ApiKeyScope = "admin" | "community";

/**
 * Read-only endpoints a community-scoped key is permitted to reach. Anything
 * not listed here (writes, admin routes) is denied for community keys.
 */
export const COMMUNITY_READ_PATHS: readonly string[] = [
  "/quotes",
  "/coverage-types",
  "/pools",
  "/transparency",
  "/treasury",
  "/oracle",
];

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Bearer-token guard for ops endpoints. Requires OPS_API_TOKEN to be set;
 * rejects with 401 when missing or mismatched.
 *
 * Community-scoped keys (COMMUNITY_API_KEYS) are accepted only on read-only
 * endpoints and are hard-rejected on every write/admin route, so a community
 * key can never be elevated to admin capability.
 */
@Injectable()
export class OpsAuthGuard implements CanActivate {
  constructor(private readonly configService: ConfigService<AppConfig, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const token = this.configService.get("ops", { infer: true }).apiToken;
    if (!token) {
      throw new UnauthorizedException({ error: "Ops API token not configured (OPS_API_TOKEN)" });
    }
    const req = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      method?: string;
      path?: string;
      url?: string;
    }>();
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      throw new UnauthorizedException({ error: "Invalid or missing ops bearer token" });
    }
    const presented = match[1];

    if (presented === token) {
      return true;
    }

    const scope = this.resolveCommunityScope(presented);
    if (scope === "community") {
      this.assertCommunityReadOnly(req);
      return true;
    }

    throw new UnauthorizedException({ error: "Invalid or missing ops bearer token" });
  }

  /**
   * Resolves the scope of a presented key against configured community keys.
   * Returns null when the key is unknown. Admin scope is never derived from a
   * community key record, so elevation is impossible by construction.
   */
  private resolveCommunityScope(presented: string): ApiKeyScope | null {
    const communityKeys = this.configService.get("ops", { infer: true }).communityApiKeys ?? [];
    return communityKeys.includes(presented) ? "community" : null;
  }

  /**
   * Security boundary: community keys are read-only. Reject any write method
   * and any path outside the allow-listed read-only surface.
   */
  private assertCommunityReadOnly(req: { method?: string; path?: string; url?: string }): void {
    const method = (req.method ?? "GET").toUpperCase();
    if (WRITE_METHODS.has(method)) {
      throw new UnauthorizedException({ error: "Community API keys are read-only" });
    }
    const rawPath = req.path ?? req.url ?? "";
    const path = rawPath.split("?")[0];
    const allowed = COMMUNITY_READ_PATHS.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );
    if (!allowed) {
      throw new UnauthorizedException({ error: "Community API keys are restricted to read-only endpoints" });
    }
  }
}
