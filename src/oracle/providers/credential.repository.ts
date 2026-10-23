import { Inject, Injectable, Logger } from "@nestjs/common";
import { Pool } from "pg";
import { DATABASE_POOL } from "../../database/database.module";
import {
  ProviderIdentity,
  ProviderKey,
  RevocationRecord,
  KeyRotationRecord,
  KeyStatus,
} from "./credentials";

/**
 * Data-access layer for provider identities, versioned keys, revocation
 * records, and rotation records.
 *
 * All revocations are append-only — nothing is ever deleted. An accidental
 * revocation is reversed by inserting a superseding revocation record and
 * setting the key status back to "active".
 */
@Injectable()
export class CredentialRepository {
  private readonly logger = new Logger(CredentialRepository.name);

  constructor(@Inject(DATABASE_POOL) private readonly db: Pool) {}

  // ── Provider identities ──────────────────────────────────────────────────

  async createProvider(name: string, contact: string): Promise<ProviderIdentity> {
    const { rows } = await this.db.query<ProviderIdentity>(
      `INSERT INTO oracle_providers (name, contact)
       VALUES ($1, $2)
       RETURNING id, name, contact, created_at AS "createdAt",
                 updated_at AS "updatedAt", is_active AS "isActive"`,
      [name, contact],
    );
    return rows[0];
  }

  async getProvider(providerId: string): Promise<ProviderIdentity | null> {
    const { rows } = await this.db.query<ProviderIdentity>(
      `SELECT id, name, contact,
              created_at AS "createdAt", updated_at AS "updatedAt",
              is_active AS "isActive"
       FROM oracle_providers WHERE id = $1`,
      [providerId],
    );
    return rows[0] ?? null;
  }

  async listProviders(): Promise<ProviderIdentity[]> {
    const { rows } = await this.db.query<ProviderIdentity>(
      `SELECT id, name, contact,
              created_at AS "createdAt", updated_at AS "updatedAt",
              is_active AS "isActive"
       FROM oracle_providers
       ORDER BY created_at DESC`,
    );
    return rows;
  }

  // ── Provider keys ────────────────────────────────────────────────────────

  async createKey(
    providerId: string,
    keyHash: string,
    version: number,
  ): Promise<ProviderKey> {
    const { rows } = await this.db.query<ProviderKey>(
      `INSERT INTO provider_keys (provider_id, key_hash, version, status)
       VALUES ($1, $2, $3, 'active')
       RETURNING id, provider_id AS "providerId", key_hash AS "keyHash",
                 version, status, created_at AS "createdAt",
                 rotating_at AS "rotatingAt", revoked_at AS "revokedAt",
                 effective_until_sequence AS "effectiveUntilSequence"`,
      [providerId, keyHash, version],
    );
    return rows[0];
  }

  async getKey(keyId: string): Promise<ProviderKey | null> {
    const { rows } = await this.db.query<ProviderKey>(
      `SELECT id, provider_id AS "providerId", key_hash AS "keyHash",
              version, status, created_at AS "createdAt",
              rotating_at AS "rotatingAt", revoked_at AS "revokedAt",
              effective_until_sequence AS "effectiveUntilSequence"
       FROM provider_keys WHERE id = $1`,
      [keyId],
    );
    return rows[0] ?? null;
  }

  async listKeysByProvider(providerId: string): Promise<ProviderKey[]> {
    const { rows } = await this.db.query<ProviderKey>(
      `SELECT id, provider_id AS "providerId", key_hash AS "keyHash",
              version, status, created_at AS "createdAt",
              rotating_at AS "rotatingAt", revoked_at AS "revokedAt",
              effective_until_sequence AS "effectiveUntilSequence"
       FROM provider_keys
       WHERE provider_id = $1
       ORDER BY version DESC`,
      [providerId],
    );
    return rows;
  }

  /**
   * Returns all active (or rotating) keys for a provider so the submission
   * boundary can check any accepted key hash.
   */
  async getAcceptableKeys(providerId: string): Promise<ProviderKey[]> {
    const { rows } = await this.db.query<ProviderKey>(
      `SELECT id, provider_id AS "providerId", key_hash AS "keyHash",
              version, status, created_at AS "createdAt",
              rotating_at AS "rotatingAt", revoked_at AS "revokedAt",
              effective_until_sequence AS "effectiveUntilSequence"
       FROM provider_keys
       WHERE provider_id = $1 AND status IN ('active', 'rotating')`,
      [providerId],
    );
    return rows;
  }

  async updateKeyStatus(
    keyId: string,
    status: KeyStatus,
    extra: {
      rotatingAt?: Date;
      revokedAt?: Date;
      effectiveUntilSequence?: number;
    } = {},
  ): Promise<void> {
    await this.db.query(
      `UPDATE provider_keys
       SET status = $2,
           rotating_at = COALESCE($3, rotating_at),
           revoked_at = COALESCE($4, revoked_at),
           effective_until_sequence = COALESCE($5, effective_until_sequence)
       WHERE id = $1`,
      [
        keyId,
        status,
        extra.rotatingAt ?? null,
        extra.revokedAt ?? null,
        extra.effectiveUntilSequence ?? null,
      ],
    );
  }

  // ── Revocation records ───────────────────────────────────────────────────

  async recordRevocation(params: {
    keyId: string;
    providerId: string;
    reason: string;
    actor: string;
    effectiveFromSequence: number;
    supersedesRevocationId?: string;
  }): Promise<RevocationRecord> {
    const { rows } = await this.db.query<RevocationRecord>(
      `INSERT INTO provider_revocations
         (key_id, provider_id, reason, actor, effective_from_sequence,
          supersedes_revocation_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, key_id AS "keyId", provider_id AS "providerId",
                 reason, actor, effective_from_sequence AS "effectiveFromSequence",
                 revoked_at AS "revokedAt",
                 supersedes_revocation_id AS "supersedesRevocationId"`,
      [
        params.keyId,
        params.providerId,
        params.reason,
        params.actor,
        params.effectiveFromSequence,
        params.supersedesRevocationId ?? null,
      ],
    );
    return rows[0];
  }

  async getRevocationsForKey(keyId: string): Promise<RevocationRecord[]> {
    const { rows } = await this.db.query<RevocationRecord>(
      `SELECT id, key_id AS "keyId", provider_id AS "providerId",
              reason, actor, effective_from_sequence AS "effectiveFromSequence",
              revoked_at AS "revokedAt",
              supersedes_revocation_id AS "supersedesRevocationId"
       FROM provider_revocations
       WHERE key_id = $1
       ORDER BY revoked_at DESC`,
      [keyId],
    );
    return rows;
  }

  async getRevocationsForProvider(providerId: string): Promise<RevocationRecord[]> {
    const { rows } = await this.db.query<RevocationRecord>(
      `SELECT id, key_id AS "keyId", provider_id AS "providerId",
              reason, actor, effective_from_sequence AS "effectiveFromSequence",
              revoked_at AS "revokedAt",
              supersedes_revocation_id AS "supersedesRevocationId"
       FROM provider_revocations
       WHERE provider_id = $1
       ORDER BY revoked_at DESC`,
      [providerId],
    );
    return rows;
  }

  // ── Rotation records ─────────────────────────────────────────────────────

  async recordRotation(params: {
    providerId: string;
    oldKeyId: string;
    newKeyId: string;
    overlapWindowEndsAt: Date;
    actor: string;
  }): Promise<KeyRotationRecord> {
    const { rows } = await this.db.query<KeyRotationRecord>(
      `INSERT INTO provider_key_rotations
         (provider_id, old_key_id, new_key_id, overlap_window_ends_at, actor)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, provider_id AS "providerId",
                 old_key_id AS "oldKeyId", new_key_id AS "newKeyId",
                 overlap_window_ends_at AS "overlapWindowEndsAt",
                 actor, initiated_at AS "initiatedAt",
                 completed_at AS "completedAt"`,
      [
        params.providerId,
        params.oldKeyId,
        params.newKeyId,
        params.overlapWindowEndsAt,
        params.actor,
      ],
    );
    return rows[0];
  }

  async completeRotation(rotationId: string): Promise<void> {
    await this.db.query(
      `UPDATE provider_key_rotations SET completed_at = now() WHERE id = $1`,
      [rotationId],
    );
  }

  async getActiveRotation(providerId: string): Promise<KeyRotationRecord | null> {
    const { rows } = await this.db.query<KeyRotationRecord>(
      `SELECT id, provider_id AS "providerId",
              old_key_id AS "oldKeyId", new_key_id AS "newKeyId",
              overlap_window_ends_at AS "overlapWindowEndsAt",
              actor, initiated_at AS "initiatedAt",
              completed_at AS "completedAt"
       FROM provider_key_rotations
       WHERE provider_id = $1 AND completed_at IS NULL
       ORDER BY initiated_at DESC LIMIT 1`,
      [providerId],
    );
    return rows[0] ?? null;
  }

  // ── Forensic queries ─────────────────────────────────────────────────────

  /**
   * Finds oracle_events contributed by a revoked key within the lookback
   * window. Used to build the affected-consensus report.
   */
  async findAffectedEvents(params: {
    providerId: string;
    effectiveFromSequence: number;
    lookbackSeconds: number;
  }): Promise<Array<{ id: bigint; coverageType: string; value: number; source: string; recordedAt: Date }>> {
    const { rows } = await this.db.query(
      `SELECT oe.id, oe.coverage_type AS "coverageType", oe.value,
              oe.source, oe.recorded_at AS "recordedAt"
       FROM oracle_events oe
       WHERE oe.source IN (
           SELECT name FROM oracle_providers WHERE id = $1
       )
       AND oe.recorded_at >= now() - ($2 * INTERVAL '1 second')
       ORDER BY oe.recorded_at DESC`,
      [params.providerId, params.lookbackSeconds],
    );
    return rows;
  }

  /**
   * Finds claims whose trigger_source matches the provider, within the
   * lookback window. These are decisions now considered suspect.
   */
  async findAffectedClaims(params: {
    providerId: string;
    lookbackSeconds: number;
  }): Promise<Array<{ id: string; policyId: string; coverageType: string; triggerSource: string; processedAt: Date }>> {
    const { rows } = await this.db.query(
      `SELECT c.id, c.policy_id AS "policyId",
              c.coverage_type AS "coverageType",
              c.trigger_source AS "triggerSource",
              c.processed_at AS "processedAt"
       FROM claims c
       WHERE c.trigger_source IN (
           SELECT name FROM oracle_providers WHERE id = $1
       )
       AND c.processed_at >= now() - ($2 * INTERVAL '1 second')
       ORDER BY c.processed_at DESC`,
      [params.providerId, params.lookbackSeconds],
    );
    return rows;
  }
}
