/**
 * Signed, Independently Verifiable Consensus Attestations with Offline Verifier (Issue #242)
 *
 * Produces deterministic canonical JSON serialization for consensus decisions,
 * computes evidence Merkle roots, signs attestations with dedicated Ed25519 keys,
 * maintains an append-only verification key registry across key rotations, and
 * provides a standalone offline verifier requiring zero trust in backend APIs.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";

export interface ConsensusAttestationPayload {
  createdAtMs: number;
  decisionId: string;
  evidenceMerkleRoot: string;
  feedId: string;
  participatingSources: string[];
  quorumResult: "satisfied" | "degraded_quorum";
  signingKeyId: string;
  consensusValueStroops: string;
}

export interface SignedConsensusAttestation {
  payload: ConsensusAttestationPayload;
  canonicalBytesUtf8: string;
  signatureBase64: string;
}

export interface PublicVerificationKeyEntry {
  keyId: string;
  algorithm: "Ed25519";
  publicKeyPem: string;
  createdAtMs: number;
  retiredAtMs?: number;
  status: "active" | "retired";
}

export interface OfflineVerificationResult {
  valid: boolean;
  reason?:
    | "unknown_signing_key"
    | "canonical_serialization_mismatch"
    | "evidence_merkle_root_mismatch"
    | "invalid_ed25519_signature";
  verifiedKeyId?: string;
  computedMerkleRoot?: string;
}

/**
 * Computes a deterministic binary Merkle tree root (SHA-256 hex) from an array
 * of evidence item strings or hashes.
 */
export function computeEvidenceMerkleRoot(evidenceItems: readonly string[]): string {
  if (evidenceItems.length === 0) {
    return createHash("sha256").update("empty_evidence_tree").digest("hex");
  }

  let level = evidenceItems
    .map((item) => createHash("sha256").update(`leaf:${item}`).digest("hex"))
    .sort();

  while (level.length > 1) {
    const nextLevel: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      const combined = createHash("sha256")
        .update(`node:${left}:${right}`)
        .digest("hex");
      nextLevel.push(combined);
    }
    level = nextLevel;
  }

  return level[0];
}

/**
 * Deterministic canonical JSON serializer with stable alphabetical key ordering
 * and sorted `participatingSources`.
 */
export function serializeCanonicalAttestationPayload(
  payload: ConsensusAttestationPayload
): string {
  const ordered = {
    consensusValueStroops: payload.consensusValueStroops,
    createdAtMs: payload.createdAtMs,
    decisionId: payload.decisionId,
    evidenceMerkleRoot: payload.evidenceMerkleRoot,
    feedId: payload.feedId,
    participatingSources: [...payload.participatingSources].sort(),
    quorumResult: payload.quorumResult,
    signingKeyId: payload.signingKeyId,
  };
  return JSON.stringify(ordered);
}

export class AttestationKeyRegistry {
  private readonly keys = new Map<
    string,
    {
      entry: PublicVerificationKeyEntry;
      privateKeyPem: string;
    }
  >();
  private activeKeyId?: string;

  /**
   * Generates and registers a new Ed25519 attestation signing key, retiring the
   * previous active key while retaining its public key for historical verification.
   */
  generateAndActivateKey(keyId: string, nowMs: number): PublicVerificationKeyEntry {
    if (this.keys.has(keyId)) {
      throw new Error(`Attestation keyId "${keyId}" already exists in append-only registry`);
    }

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    if (this.activeKeyId) {
      const prev = this.keys.get(this.activeKeyId);
      if (prev) {
        prev.entry.status = "retired";
        prev.entry.retiredAtMs = nowMs;
      }
    }

    const entry: PublicVerificationKeyEntry = {
      keyId,
      algorithm: "Ed25519",
      publicKeyPem,
      createdAtMs: nowMs,
      status: "active",
    };

    this.keys.set(keyId, { entry, privateKeyPem });
    this.activeKeyId = keyId;
    return { ...entry };
  }

  /**
   * Signs a consensus decision attestation using the currently active Ed25519 key.
   */
  signDecisionAttestation(params: {
    decisionId: string;
    feedId: string;
    consensusValueStroops: bigint;
    participatingSources: readonly string[];
    quorumResult: "satisfied" | "degraded_quorum";
    evidenceItems: readonly string[];
    createdAtMs: number;
  }): SignedConsensusAttestation {
    if (!this.activeKeyId) {
      throw new Error("No active Ed25519 attestation signing key configured");
    }
    const active = this.keys.get(this.activeKeyId)!;
    const evidenceMerkleRoot = computeEvidenceMerkleRoot(params.evidenceItems);

    const payload: ConsensusAttestationPayload = {
      consensusValueStroops: params.consensusValueStroops.toString(),
      createdAtMs: params.createdAtMs,
      decisionId: params.decisionId,
      evidenceMerkleRoot,
      feedId: params.feedId,
      participatingSources: [...params.participatingSources].sort(),
      quorumResult: params.quorumResult,
      signingKeyId: active.entry.keyId,
    };

    const canonicalBytesUtf8 = serializeCanonicalAttestationPayload(payload);
    const privKeyObj = createPrivateKey(active.privateKeyPem);
    const sigBuf = cryptoSign(
      null,
      Buffer.from(canonicalBytesUtf8, "utf8"),
      privKeyObj
    );

    return {
      payload,
      canonicalBytesUtf8,
      signatureBase64: sigBuf.toString("base64"),
    };
  }

  /**
   * Exports all active and historical retired public verification keys for the
   * well-known endpoint and offline verifier. Never exposes private key material.
   */
  exportPublicVerificationKeys(): PublicVerificationKeyEntry[] {
    return Array.from(this.keys.values()).map(({ entry }) => ({ ...entry }));
  }
}

/**
 * Standalone Offline Verifier: verifies canonical serialization, recomputes the
 * evidence Merkle root from raw evidence items (when provided), and checks the
 * Ed25519 signature against the published verification key bundle.
 */
export function verifyConsensusAttestationOffline(
  attestation: SignedConsensusAttestation,
  publishedKeys: readonly PublicVerificationKeyEntry[],
  rawEvidenceItems?: readonly string[]
): OfflineVerificationResult {
  const keyEntry = publishedKeys.find(
    (k) => k.keyId === attestation.payload.signingKeyId
  );
  if (!keyEntry) {
    return {
      valid: false,
      reason: "unknown_signing_key",
    };
  }

  const expectedCanonical = serializeCanonicalAttestationPayload(
    attestation.payload
  );
  if (expectedCanonical !== attestation.canonicalBytesUtf8) {
    return {
      valid: false,
      reason: "canonical_serialization_mismatch",
      verifiedKeyId: keyEntry.keyId,
    };
  }

  if (rawEvidenceItems !== undefined) {
    const computedRoot = computeEvidenceMerkleRoot(rawEvidenceItems);
    if (computedRoot !== attestation.payload.evidenceMerkleRoot) {
      return {
        valid: false,
        reason: "evidence_merkle_root_mismatch",
        verifiedKeyId: keyEntry.keyId,
        computedMerkleRoot: computedRoot,
      };
    }
  }

  try {
    const pubKeyObj = createPublicKey(keyEntry.publicKeyPem);
    const sigBuf = Buffer.from(attestation.signatureBase64, "base64");
    const isSigValid = cryptoVerify(
      null,
      Buffer.from(expectedCanonical, "utf8"),
      pubKeyObj,
      sigBuf
    );
    if (!isSigValid) {
      return {
        valid: false,
        reason: "invalid_ed25519_signature",
        verifiedKeyId: keyEntry.keyId,
      };
    }
  } catch {
    return {
      valid: false,
      reason: "invalid_ed25519_signature",
      verifiedKeyId: keyEntry.keyId,
    };
  }

  return {
    valid: true,
    verifiedKeyId: keyEntry.keyId,
    computedMerkleRoot: attestation.payload.evidenceMerkleRoot,
  };
}
