import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Identity model for operator-facing oracle controls.
 *
 * Every operator holds one or more API keys. A key belongs to exactly one
 * actor (a person or service account) and carries exactly one role. Only the
 * SHA-256 of the key's secret is configured, so the server never stores a
 * usable credential.
 *
 * Tokens are presented as `Authorization: Bearer <keyId>.<secret>`. The key
 * id selects the credential, and the secret is compared in constant time.
 * Each key can be rotated or revoked without touching the others.
 */

export const ORACLE_PERMISSIONS = [
  "feeds:read",
  "feeds:write",
  "quorum:write",
  "feeds:pause",
  "quarantine:override",
  "manual:override",
  "bootstrap:run",
  "audit:read",
] as const;
export type OraclePermission = (typeof ORACLE_PERMISSIONS)[number];

export const ORACLE_ROLES = ["oracle:viewer", "oracle:operator", "oracle:admin"] as const;
export type OracleRole = (typeof ORACLE_ROLES)[number];

/**
 * Viewers can look. Operators can make reversible, safety-direction changes
 * (pause/resume a feed, re-run a bootstrap). Only admins can change what
 * the oracle believes: feed definitions, quorum policy, quarantine
 * overrides, manual value overrides. Admins can also read the audit trail.
 */
export const ROLE_PERMISSIONS: Record<OracleRole, readonly OraclePermission[]> = {
  "oracle:viewer": ["feeds:read"],
  "oracle:operator": ["feeds:read", "feeds:pause", "bootstrap:run"],
  "oracle:admin": ORACLE_PERMISSIONS,
};

export interface OperatorCredential {
  keyId: string;
  actor: string;
  role: OracleRole;
  /** Hex SHA-256 of the secret part of the token. */
  secretSha256: string;
  expiresAt?: string;
  disabled?: boolean;
}

export interface OperatorIdentity {
  actor: string;
  role: OracleRole;
  keyId: string;
  permissions: readonly OraclePermission[];
}

const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

const credentialSchema = z
  .object({
    keyId: z.string().regex(KEY_ID_PATTERN, "keyId must be 2-63 chars of a-z, 0-9, and '-'"),
    actor: z.string().min(1).max(128),
    role: z.enum(ORACLE_ROLES),
    secretSha256: z.string().regex(/^[0-9a-f]{64}$/, "secretSha256 must be 64 lowercase hex chars"),
    expiresAt: z
      .string()
      .refine((value) => !Number.isNaN(Date.parse(value)), "expiresAt must be an ISO-8601 timestamp")
      .optional(),
    disabled: z.boolean().optional(),
  })
  .strict();

/**
 * Parses `ORACLE_OPERATOR_KEYS`, a JSON array of credentials. Returns an
 * empty list when unset; the guard then answers 503 rather than letting
 * anyone in.
 */
export function parseOperatorCredentials(raw: string | undefined): OperatorCredential[] {
  if (raw === undefined || raw.trim() === "") return [];

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("ORACLE_OPERATOR_KEYS is not valid JSON");
  }

  const result = z.array(credentialSchema).safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`ORACLE_OPERATOR_KEYS is invalid:\n  - ${issues.join("\n  - ")}`);
  }

  const seen = new Set<string>();
  for (const credential of result.data) {
    if (seen.has(credential.keyId)) {
      throw new Error(`ORACLE_OPERATOR_KEYS defines keyId "${credential.keyId}" more than once`);
    }
    seen.add(credential.keyId);
  }
  return result.data;
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Mints a new key. Give `token` to the operator; put `credential` in ORACLE_OPERATOR_KEYS. */
export function generateOperatorKey(
  keyId: string,
  actor: string,
  role: OracleRole
): { token: string; credential: OperatorCredential } {
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new Error("keyId must be 2-63 chars of a-z, 0-9, and '-'");
  }
  const secret = randomBytes(32).toString("base64url");
  return {
    token: `${keyId}.${secret}`,
    credential: { keyId, actor, role, secretSha256: hashSecret(secret) },
  };
}

export type AuthFailureReason =
  | "missing_credentials"
  | "malformed_token"
  | "unknown_key"
  | "invalid_secret"
  | "key_disabled"
  | "key_expired";

export class OperatorAuthError extends Error {
  constructor(
    readonly reason: AuthFailureReason,
    readonly keyId?: string
  ) {
    super(reason);
  }
}

/**
 * Resolves a bearer token to an operator identity. Every failure throws
 * {@link OperatorAuthError}. Its `reason` goes to the audit log; clients get
 * one generic 401 so they cannot probe which key ids exist.
 */
export class OperatorAuthenticator {
  private readonly byKeyId: Map<string, OperatorCredential>;

  constructor(
    credentials: OperatorCredential[],
    private readonly now: () => number = Date.now
  ) {
    this.byKeyId = new Map(credentials.map((credential) => [credential.keyId, credential]));
  }

  get configured(): boolean {
    return this.byKeyId.size > 0;
  }

  authenticate(authorization: string | undefined): OperatorIdentity {
    if (!authorization) throw new OperatorAuthError("missing_credentials");

    const match = /^Bearer\s+([a-z0-9-]+)\.([A-Za-z0-9_-]{16,})$/.exec(authorization.trim());
    if (!match) throw new OperatorAuthError("malformed_token");
    const [, keyId, secret] = match;

    // Hash before the lookup so unknown and known key ids cost the same.
    const presented = Buffer.from(hashSecret(secret), "hex");
    const credential = this.byKeyId.get(keyId);
    if (!credential) throw new OperatorAuthError("unknown_key", keyId);
    if (!timingSafeEqual(presented, Buffer.from(credential.secretSha256, "hex"))) {
      throw new OperatorAuthError("invalid_secret", keyId);
    }
    if (credential.disabled) throw new OperatorAuthError("key_disabled", keyId);
    if (credential.expiresAt && Date.parse(credential.expiresAt) <= this.now()) {
      throw new OperatorAuthError("key_expired", keyId);
    }

    return {
      actor: credential.actor,
      role: credential.role,
      keyId,
      permissions: ROLE_PERMISSIONS[credential.role],
    };
  }
}
