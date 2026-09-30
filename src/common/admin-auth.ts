import { timingSafeEqual } from "node:crypto";
import { Injectable, SetMetadata, UnauthorizedException, ServiceUnavailableException, type ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { AppConfig } from "../config/configuration";

const ADMIN_ONLY_METADATA = "admin-only";

export function AdminOnly(): MethodDecorator & ClassDecorator {
  return SetMetadata(ADMIN_ONLY_METADATA, true);
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
    if (!isAdminOnly) return true;

    const configuredKey = this.configService.get("adminApiKey", { infer: true });
    if (!configuredKey) {
      throw new ServiceUnavailableException({
        code: "ADMIN_AUTH_NOT_CONFIGURED",
        error: "Admin authentication is not configured.",
      });
    }

    const request = context.switchToHttp().getRequest<{ get(name: string): string | undefined }>();
    const providedKey = request.get("x-api-key");
    if (!providedKey || !this.keysMatch(providedKey, configuredKey)) {
      throw new UnauthorizedException({
        code: "ADMIN_AUTH_REQUIRED",
        error: "A valid admin API key is required.",
      });
    }

    return true;
  }

  private keysMatch(providedKey: string, configuredKey: string): boolean {
    const provided = Buffer.from(providedKey);
    const configured = Buffer.from(configuredKey);
    return provided.length === configured.length && timingSafeEqual(provided, configured);
  }
}
