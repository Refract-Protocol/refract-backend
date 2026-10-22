import { createHash, timingSafeEqual, randomBytes } from "crypto";

/**
 * Provider identity and credential types.
 *
 * Identities are stable provider-level records. Keys are versioned child
 * records so revocation is a key-level operation — the provider survives
 * a rotation. Revocations are append-only (a superseding record reverses
 * an accidental revocation; nothing is ever deleted).
 */

export type KeyStatus = "active" | "rotating" | "revoked" | "superseded";

export interface ProviderIdentity {
  id: string;
  name: string;
  contact: string;
  createdAt: Date;
  updatedAt: Date;
  isActive: boolean;
}

export interface ProviderKey {
  id: string;
  providerId: string;
  /** PBKDF2-SHA256 hash of the raw key — never store plaintext. */
  keyHash: string;
  /** Key version counter, incremented on each rotation. */
  version: number;
  status: KeyStatus;
  createdAt: Date;
  /** Set when this key enters the rotating state (overlap window start). */
  rotatingAt: Date | null;
  /** Set when revocation or supersession is recorded. */
  revokedAt: Date | null;
  /** Ledger sequence number at which this key is no longer accepted. */
  effectiveUntilSequence: number | null;
}

export interface RevocationRecord {
  id: string;
  keyId: string;
  providerId: string;
  reason: string;
  actor: string;
  /** Ledger sequence from which submissions with this key are rejected. */
  effectiveFromSequence: number;
  /** Timestamp of the revocation action. */
  revokedAt: Date;
  /** If set, this record supersedes a prior accidental revocation. */
  supersedesRevocationId: string | null;
}

export interface KeyRotationRecord {
  id: string;
  providerId: string;
  oldKeyId: string;
  newKeyId: string;
  /** Both keys are accepted during the overlap window. */
  overlapWindowEndsAt: Date;
  actor: string;
  initiatedAt: Date;
  completedAt: Date | null;
}

/**
 * Generate a new raw API key (32 random bytes, hex-encoded).
 * The caller stores the raw value once, then discards it.
 */
export function generateRawKey(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Hash a raw API key using SHA-256. The hash is stored in the DB;
 * the raw key is shown to the operator exactly once.
 */
export function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

/**
 * Timing-safe comparison of a presented raw key against a stored hash.
 */
export function verifyKey(rawKey: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashKey(rawKey), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}
