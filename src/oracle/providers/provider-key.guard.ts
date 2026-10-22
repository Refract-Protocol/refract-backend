import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ProviderCredentialService } from "./provider-credential.service";

export interface ProviderRequest {
  headers: Record<string, string | string[] | undefined>;
  authenticatedProvider?: { providerId: string; keyId: string; keyVersion: number };
}

/**
 * Submission-boundary guard: validates the provider ID and raw API key
 * supplied in request headers before any oracle reading is accepted.
 *
 * Headers:
 *   x-provider-id  — stable provider UUID
 *   x-provider-key — raw API key (shown once at registration/rotation)
 *
 * Rejected immediately if:
 *   - Headers are absent
 *   - Provider does not exist
 *   - Key is revoked, superseded, or unknown
 *   - Submission falls after effectiveUntilSequence on the key
 *
 * On success, attaches authenticatedProvider to the request for downstream use.
 */
@Injectable()
export class ProviderKeyGuard implements CanActivate {
  constructor(private readonly credentialService: ProviderCredentialService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ProviderRequest>();

    const providerId = this.extractHeader(req, "x-provider-id");
    const rawKey = this.extractHeader(req, "x-provider-key");

    if (!providerId || !rawKey) {
      throw new UnauthorizedException(
        "Oracle submissions require x-provider-id and x-provider-key headers",
      );
    }

    const key = await this.credentialService.validateSubmission(providerId, rawKey);

    req.authenticatedProvider = {
      providerId,
      keyId: key.id,
      keyVersion: key.version,
    };

    return true;
  }

  private extractHeader(req: ProviderRequest, name: string): string | undefined {
    const val = req.headers[name];
    return Array.isArray(val) ? val[0] : val;
  }
}
