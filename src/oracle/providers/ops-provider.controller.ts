import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { AdminOnly } from "../../common/admin-auth";
import { AdminApiKeyGuard } from "../../common/admin-auth";
import { ProviderCredentialService } from "./provider-credential.service";

interface RegisterProviderDto {
  name: string;
  contact: string;
}

interface RevokeKeyDto {
  reason: string;
  actor: string;
  effectiveFromSequence: number;
  lookbackSeconds?: number;
}

interface ReverseRevocationDto {
  supersedesRevocationId: string;
  reason: string;
  actor: string;
  effectiveFromSequence: number;
}

interface InitiateRotationDto {
  actor: string;
  overlapWindowSeconds?: number;
}

interface CompleteRotationDto {
  actor: string;
}

/**
 * Ops endpoints for oracle provider identity and credential management.
 *
 * All write actions require the admin API key (x-api-key header).
 * Trust-status (GET) is publicly readable for the provenance surface.
 *
 * POST /ops/providers                      — register a new provider
 * GET  /ops/providers                      — list all providers
 * GET  /ops/providers/:id/keys             — list keys for a provider
 * POST /ops/providers/:id/keys/revoke      — revoke a key (produces forensic report)
 * POST /ops/providers/:id/keys/reverse-revocation — reverse an accidental revocation
 * POST /ops/providers/:id/keys/rotate      — initiate key rotation (overlap window)
 * POST /ops/providers/:id/keys/rotate/complete — complete rotation
 * GET  /ops/providers/:id/trust-status     — public trust/provenance surface
 */
@Controller("ops/providers")
@UseGuards(AdminApiKeyGuard)
export class OpsProviderController {
  constructor(private readonly credentialService: ProviderCredentialService) {}

  @Post()
  @AdminOnly()
  async registerProvider(@Body() dto: RegisterProviderDto) {
    const { provider, rawKey } = await this.credentialService.registerProvider(
      dto.name,
      dto.contact,
    );
    return {
      provider,
      // Raw key is shown exactly once; it cannot be recovered after this response.
      rawKey,
      warning: "Store this key securely. It will not be shown again.",
    };
  }

  @Get()
  @AdminOnly()
  async listProviders() {
    return this.credentialService.listProviders();
  }

  @Get(":providerId/keys")
  @AdminOnly()
  async listKeys(@Param("providerId") providerId: string) {
    const provider = await this.credentialService.getProvider(providerId);
    const trust = await this.credentialService.getTrustStatus(providerId);
    return { provider, ...trust };
  }

  /**
   * Revoke a specific key. Returns a full forensic report of every oracle
   * event and claim decision the provider contributed to within the lookback
   * window. This report is linked to claim remediation.
   */
  @Post(":providerId/keys/:keyId/revoke")
  @AdminOnly()
  @HttpCode(HttpStatus.OK)
  async revokeKey(
    @Param("providerId") _providerId: string,
    @Param("keyId") keyId: string,
    @Body() dto: RevokeKeyDto,
  ) {
    return this.credentialService.revokeKey({
      keyId,
      reason: dto.reason,
      actor: dto.actor,
      effectiveFromSequence: dto.effectiveFromSequence,
      lookbackSeconds: dto.lookbackSeconds,
    });
  }

  /**
   * Reverse an accidental revocation. Inserts a superseding record; the
   * original revocation is preserved for evidence retention.
   */
  @Post(":providerId/keys/:keyId/reverse-revocation")
  @AdminOnly()
  @HttpCode(HttpStatus.OK)
  async reverseRevocation(
    @Param("keyId") keyId: string,
    @Body() dto: ReverseRevocationDto,
  ) {
    return this.credentialService.reverseRevocation({
      keyId,
      supersedesRevocationId: dto.supersedesRevocationId,
      reason: dto.reason,
      actor: dto.actor,
      effectiveFromSequence: dto.effectiveFromSequence,
    });
  }

  /**
   * Initiate key rotation. Old key moves to "rotating" (still accepted during
   * overlap window). Returns the new raw key — shown once.
   */
  @Post(":providerId/keys/rotate")
  @AdminOnly()
  @HttpCode(HttpStatus.OK)
  async initiateRotation(
    @Param("providerId") providerId: string,
    @Body() dto: InitiateRotationDto,
  ) {
    const result = await this.credentialService.initiateRotation({
      providerId,
      actor: dto.actor,
      overlapWindowSeconds: dto.overlapWindowSeconds,
    });
    return {
      ...result,
      warning: "Store the new rawKey securely. It will not be shown again.",
    };
  }

  /**
   * Complete a rotation once the new key is confirmed in use.
   * Old key is superseded and no longer accepted.
   */
  @Post(":providerId/keys/rotate/complete")
  @AdminOnly()
  @HttpCode(HttpStatus.OK)
  async completeRotation(
    @Param("providerId") providerId: string,
    @Body() dto: CompleteRotationDto,
  ) {
    await this.credentialService.completeRotation({
      providerId,
      actor: dto.actor,
    });
    return { message: "Rotation completed. Old key is now superseded." };
  }

  /**
   * Public trust/provenance surface. Returns key counts, in-progress rotation,
   * and revocation history for downstream consumers.
   */
  @Get(":providerId/trust-status")
  async getTrustStatus(@Param("providerId") providerId: string) {
    return this.credentialService.getTrustStatus(providerId);
  }
}
