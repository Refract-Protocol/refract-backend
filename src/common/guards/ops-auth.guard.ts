import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../../config/configuration";

/**
 * Bearer-token guard for ops endpoints. Requires OPS_API_TOKEN to be set;
 * rejects with 401 when missing or mismatched.
 */
@Injectable()
export class OpsAuthGuard implements CanActivate {
  constructor(private readonly configService: ConfigService<AppConfig, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const token = this.configService.get("ops", { infer: true }).apiToken;
    if (!token) {
      throw new UnauthorizedException({ error: "Ops API token not configured (OPS_API_TOKEN)" });
    }
    const req = context.switchToHttp().getRequest<{ headers: { authorization?: string } }>();
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || match[1] !== token) {
      throw new UnauthorizedException({ error: "Invalid or missing ops bearer token" });
    }
    return true;
  }
}
