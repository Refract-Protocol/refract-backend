import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { CredentialRepository } from "./credential.repository";
import {
  generateRawKey,
  hashKey,
  verifyKey,
  ProviderIdentity,
  ProviderKey,
  RevocationRecord,
  KeyRotationRecord,
} from "./credentials";

/** Default overlap window for a healthy rotation (seconds). */
const DEFAULT_OVERLAP_WINDOW_SECONDS = 300; // 5 minutes

/** Default lookback when building a forensic report (seconds). */
const DEFAULT_LOOKBACK_SECONDS = 86_400 * 7; // 7 days

export interface ForensicReport {
  provider: ProviderIdentity;
  revocation: RevocationRecord;
  affectedEvents: Array<{
    id: bigint;
    coverageType: string;
    value: number;
    source: string;
    recordedAt: Date;
  }>;
  affectedClaims: Array<{
    id: string;
    policyId: string;
    coverageType: string;
    triggerSource: string;
    processedAt: Date;
  }>;
  generatedAt: Date;
}

export interface RotationResult {
  oldKey: ProviderKey;
  newKey: ProviderKey;
  rawKey: string;
  rotation: KeyRotationRecord;
  overlapWindowEndsAt: Date;
}

@Injectable()
export class ProviderCredentialService {
  private readonly logger = new Logger(ProviderCredentialService.name);

  constructor(private readonly repo: CredentialRepository) {}

  // ── Provider management ──────────────────────────────────────────────────

  async registerProvider(name: string, contact: string): Promise<{ provider: ProviderIdentity; rawKey: string }> {
    const provider = await this.repo.createProvider(name, contact);
    const rawKey = generateRawKey();
    await this.repo.createKey(provider.id, hashKey(rawKey), 1);
    this.logger.log(`Registered provider ${provider.id} (${name})`);
    return { provider, rawKey };
  }

  async getProvider(providerId: string): Promise<ProviderIdentity> {
    const p = await this.repo.getProvider(providerId);
    if (!p) throw new NotFoundException(`Provider ${providerId} not found`);
    return p;
  }

  async listProviders(): Promise<ProviderIdentity[]> {
    return this.repo.listProviders();
  }

  // ── Submission boundary check ────────────────────────────────────────────

  /**
   * Validates a raw API key at the submission boundary.
   * Returns the matching key record, or throws UnauthorizedException.
   * Called on every inbound oracle submission before it is accepted.
   */
  async validateSubmission(providerId: string, rawKey: string): Promise<ProviderKey> {
    const acceptableKeys = await this.repo.getAcceptableKeys(providerId);
    for (const key of acceptableKeys) {
      if (verifyKey(rawKey, key.keyHash)) {
        return key;
      }
    }
    throw new UnauthorizedException(
      `No valid active key for provider ${providerId}. Key may be revoked or unknown.`,
    );
  }

  // ── Revocation ────────────────────────────────────────────────────────────

  /**
   * Revokes a provider key immediately.
   *
   * - Marks the key as "revoked" in provider_keys.
   * - Inserts an append-only revocation record with reason, actor, and
   *   effective-from sequence.
   * - Builds and returns a forensic report of every oracle event and claim
   *   decision this provider contributed to within the lookback window.
   *
   * Revocations are never deletable. Accidental revocations are reversed by
   * calling reverseRevocation(), which inserts a superseding record and
   * restores the key to "active".
   */
  async revokeKey(params: {
    keyId: string;
    reason: string;
    actor: string;
    effectiveFromSequence: number;
    lookbackSeconds?: number;
  }): Promise<ForensicReport> {
    const key = await this.repo.getKey(params.keyId);
    if (!key) throw new NotFoundException(`Key ${params.keyId} not found`);
    if (key.status === "revoked") {
      throw new ConflictException(`Key ${params.keyId} is already revoked`);
    }

    const provider = await this.repo.getProvider(key.providerId);
    if (!provider) throw new NotFoundException(`Provider ${key.providerId} not found`);

    await this.repo.updateKeyStatus(params.keyId, "revoked", {
      revokedAt: new Date(),
      effectiveUntilSequence: params.effectiveFromSequence,
    });

    const revocation = await this.repo.recordRevocation({
      keyId: params.keyId,
      providerId: key.providerId,
      reason: params.reason,
      actor: params.actor,
      effectiveFromSequence: params.effectiveFromSequence,
    });

    this.logger.warn(
      `Key ${params.keyId} (provider ${key.providerId}) revoked by ${params.actor} ` +
        `effective from sequence ${params.effectiveFromSequence}. Reason: ${params.reason}`,
    );

    return this.buildForensicReport(
      provider,
      revocation,
      params.lookbackSeconds ?? DEFAULT_LOOKBACK_SECONDS,
    );
  }

  /**
   * Reverses an accidental revocation by restoring the key to "active" and
   * inserting a superseding revocation record. The original record is preserved
   * for evidence retention.
   */
  async reverseRevocation(params: {
    keyId: string;
    supersedesRevocationId: string;
    reason: string;
    actor: string;
    effectiveFromSequence: number;
  }): Promise<RevocationRecord> {
    const key = await this.repo.getKey(params.keyId);
    if (!key) throw new NotFoundException(`Key ${params.keyId} not found`);
    if (key.status !== "revoked") {
      throw new BadRequestException(`Key ${params.keyId} is not currently revoked`);
    }

    await this.repo.updateKeyStatus(params.keyId, "active", {
      revokedAt: undefined,
      effectiveUntilSequence: undefined,
    });

    const superseding = await this.repo.recordRevocation({
      keyId: params.keyId,
      providerId: key.providerId,
      reason: params.reason,
      actor: params.actor,
      effectiveFromSequence: params.effectiveFromSequence,
      supersedesRevocationId: params.supersedesRevocationId,
    });

    this.logger.log(
      `Revocation reversed for key ${params.keyId} by ${params.actor}. ` +
        `Supersedes revocation ${params.supersedesRevocationId}`,
    );

    return superseding;
  }

  // ── Key rotation ──────────────────────────────────────────────────────────

  /**
   * Initiates active key rotation for a healthy provider.
   *
   * - Creates a new key (next version) in "active" status.
   * - Sets the old key to "rotating" — it remains valid during the overlap
   *   window.
   * - Records a rotation record for audit and overlap-window tracking.
   *
   * During the overlap window both the old and new keys are accepted at the
   * submission boundary. Call completeRotation() when the new key is confirmed
   * in use to retire the old key.
   */
  async initiateRotation(params: {
    providerId: string;
    actor: string;
    overlapWindowSeconds?: number;
  }): Promise<RotationResult> {
    const provider = await this.repo.getProvider(params.providerId);
    if (!provider) throw new NotFoundException(`Provider ${params.providerId} not found`);

    const existing = await this.repo.getActiveRotation(params.providerId);
    if (existing) {
      throw new ConflictException(
        `Provider ${params.providerId} already has an in-progress rotation`,
      );
    }

    const currentKeys = await this.repo.listKeysByProvider(params.providerId);
    const activeKey = currentKeys.find((k) => k.status === "active");
    if (!activeKey) {
      throw new BadRequestException(
        `Provider ${params.providerId} has no active key to rotate`,
      );
    }

    const nextVersion = Math.max(...currentKeys.map((k) => k.version)) + 1;
    const rawKey = generateRawKey();
    const newKey = await this.repo.createKey(
      params.providerId,
      hashKey(rawKey),
      nextVersion,
    );

    const overlapSeconds = params.overlapWindowSeconds ?? DEFAULT_OVERLAP_WINDOW_SECONDS;
    const overlapWindowEndsAt = new Date(Date.now() + overlapSeconds * 1000);

    await this.repo.updateKeyStatus(activeKey.id, "rotating", {
      rotatingAt: new Date(),
    });

    const rotation = await this.repo.recordRotation({
      providerId: params.providerId,
      oldKeyId: activeKey.id,
      newKeyId: newKey.id,
      overlapWindowEndsAt,
      actor: params.actor,
    });

    this.logger.log(
      `Rotation initiated for provider ${params.providerId} by ${params.actor}. ` +
        `Old key: ${activeKey.id} → New key: ${newKey.id}. ` +
        `Overlap window ends: ${overlapWindowEndsAt.toISOString()}`,
    );

    return {
      oldKey: { ...activeKey, status: "rotating" },
      newKey,
      rawKey,
      rotation,
      overlapWindowEndsAt,
    };
  }

  /**
   * Completes a rotation once the new key is confirmed in use.
   * Supersedes the old key and closes the overlap window.
   */
  async completeRotation(params: {
    providerId: string;
    actor: string;
  }): Promise<void> {
    const rotation = await this.repo.getActiveRotation(params.providerId);
    if (!rotation) {
      throw new NotFoundException(`No active rotation found for provider ${params.providerId}`);
    }

    await this.repo.updateKeyStatus(rotation.oldKeyId, "superseded", {
      revokedAt: new Date(),
    });
    await this.repo.completeRotation(rotation.id);

    this.logger.log(
      `Rotation completed for provider ${params.providerId} by ${params.actor}. ` +
        `Old key ${rotation.oldKeyId} superseded.`,
    );
  }

  // ── Forensic report ───────────────────────────────────────────────────────

  /**
   * Builds a full forensic report for a provider: all oracle events and claim
   * decisions it contributed to within the lookback window, linked to the
   * revocation record for claim remediation.
   */
  async buildForensicReport(
    provider: ProviderIdentity,
    revocation: RevocationRecord,
    lookbackSeconds: number = DEFAULT_LOOKBACK_SECONDS,
  ): Promise<ForensicReport> {
    const [affectedEvents, affectedClaims] = await Promise.all([
      this.repo.findAffectedEvents({
        providerId: provider.id,
        effectiveFromSequence: revocation.effectiveFromSequence,
        lookbackSeconds,
      }),
      this.repo.findAffectedClaims({
        providerId: provider.id,
        lookbackSeconds,
      }),
    ]);

    this.logger.log(
      `Forensic report for provider ${provider.id}: ` +
        `${affectedEvents.length} events, ${affectedClaims.length} claims in lookback window`,
    );

    return {
      provider,
      revocation,
      affectedEvents,
      affectedClaims,
      generatedAt: new Date(),
    };
  }

  // ── Trust status surface ─────────────────────────────────────────────────

  /**
   * Returns the public trust-status for a provider: active key count,
   * revocation count, and any in-progress rotation. Used by the provenance
   * surface.
   */
  async getTrustStatus(providerId: string): Promise<{
    providerId: string;
    isActive: boolean;
    activeKeyCount: number;
    revokedKeyCount: number;
    rotatingKeyCount: number;
    inProgressRotation: KeyRotationRecord | null;
    revocationHistory: RevocationRecord[];
  }> {
    const provider = await this.repo.getProvider(providerId);
    if (!provider) throw new NotFoundException(`Provider ${providerId} not found`);

    const [keys, revocations, rotation] = await Promise.all([
      this.repo.listKeysByProvider(providerId),
      this.repo.getRevocationsForProvider(providerId),
      this.repo.getActiveRotation(providerId),
    ]);

    return {
      providerId,
      isActive: provider.isActive,
      activeKeyCount: keys.filter((k) => k.status === "active").length,
      revokedKeyCount: keys.filter((k) => k.status === "revoked").length,
      rotatingKeyCount: keys.filter((k) => k.status === "rotating").length,
      inProgressRotation: rotation,
      revocationHistory: revocations,
    };
  }
}
