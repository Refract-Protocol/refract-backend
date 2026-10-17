/**
 * Provider Credential Revocation, Key Rotation, and Compromise Response Workflow (Issue #283)
 *
 * Manages versioned child credentials per stable provider ID, enforces key-level
 * revocation at submission and consensus inclusion boundaries, supports overlap-window
 * rotation, allows append-only reversal of accidental revocations, and produces
 * forensic impact reports of affected consensus decisions and claims.
 */

export type CredentialLifecycleState =
  | "active"
  | "rotation_overlap"
  | "retired"
  | "revoked";

export interface ProviderCredentialVersion {
  providerId: string;
  keyId: string;
  version: number;
  publicKeyFingerprint: string;
  createdAtMs: number;
  overlapExpiresAtMs?: number;
  state: CredentialLifecycleState;
}

export interface CredentialLedgerEvent {
  eventId: string;
  eventType:
    | "key_registered"
    | "key_rotated"
    | "key_revoked"
    | "revocation_superseded";
  providerId: string;
  keyId: string;
  actorId: string;
  reason: string;
  timestampMs: number;
  effectiveFromSequence: number;
  supersedesEventId?: string;
}

export interface ContributedReadingRecord {
  readingId: string;
  providerId: string;
  keyId: string;
  feedId: string;
  sequenceNumber: number;
  observedAtMs: number;
  quarantined: boolean;
}

export interface ConsensusDecisionEvidenceRecord {
  decisionId: string;
  feedId: string;
  decidedAtMs: number;
  sequenceNumber: number;
  includedReadingIds: string[];
  linkedClaimIds: string[];
}

export interface CompromiseForensicReport {
  revocationEventId: string;
  providerId: string;
  revokedKeyId: string;
  effectiveFromSequence: number;
  lookbackStartMs: number;
  quarantinedReadingIds: string[];
  affectedDecisionIds: string[];
  remediationClaimIds: string[];
  generatedAtMs: number;
}

export interface CredentialVerificationResult {
  accepted: boolean;
  providerId: string;
  keyId: string;
  rejectionReason?:
    | "unknown_provider"
    | "unknown_key"
    | "key_revoked"
    | "rotation_overlap_expired"
    | "key_retired";
}

export class ProviderCredentialManager {
  private readonly keysByProvider = new Map<string, ProviderCredentialVersion[]>();
  private readonly ledgerEvents: CredentialLedgerEvent[] = [];
  private readonly readings = new Map<string, ContributedReadingRecord>();
  private readonly decisions = new Map<string, ConsensusDecisionEvidenceRecord>();
  private eventSeq = 0;

  /**
   * Registers the initial credential key for a provider.
   */
  registerProviderKey(params: {
    providerId: string;
    keyId: string;
    publicKeyFingerprint: string;
    actorId: string;
    nowMs: number;
    sequenceNumber?: number;
  }): ProviderCredentialVersion {
    const existing = this.keysByProvider.get(params.providerId) ?? [];
    if (existing.some((k) => k.keyId === params.keyId)) {
      throw new Error(`Key "${params.keyId}" already exists for provider "${params.providerId}"`);
    }

    const version = existing.length + 1;
    const record: ProviderCredentialVersion = {
      providerId: params.providerId,
      keyId: params.keyId,
      version,
      publicKeyFingerprint: params.publicKeyFingerprint,
      createdAtMs: params.nowMs,
      state: "active",
    };
    existing.push(record);
    this.keysByProvider.set(params.providerId, existing);

    this.appendEvent({
      eventType: "key_registered",
      providerId: params.providerId,
      keyId: params.keyId,
      actorId: params.actorId,
      reason: `Registered key v${version}`,
      timestampMs: params.nowMs,
      effectiveFromSequence: params.sequenceNumber ?? 0,
    });

    return { ...record };
  }

  /**
   * Rotates a healthy provider to a new key with an overlap window so both
   * the old key and the new key are valid until `nowMs + overlapWindowMs`.
   */
  rotateProviderKey(params: {
    providerId: string;
    newKeyId: string;
    newPublicKeyFingerprint: string;
    overlapWindowMs: number;
    actorId: string;
    nowMs: number;
    sequenceNumber?: number;
  }): { previousKey?: ProviderCredentialVersion; newKey: ProviderCredentialVersion } {
    if (params.overlapWindowMs < 0) {
      throw new Error("overlapWindowMs cannot be negative");
    }
    const keys = this.keysByProvider.get(params.providerId);
    if (!keys || keys.length === 0) {
      throw new Error(`Unknown provider "${params.providerId}"`);
    }

    let previousKey: ProviderCredentialVersion | undefined;
    for (const k of keys) {
      if (k.state === "active") {
        k.state = params.overlapWindowMs > 0 ? "rotation_overlap" : "retired";
        k.overlapExpiresAtMs = params.nowMs + params.overlapWindowMs;
        previousKey = { ...k };
      }
    }

    const version = keys.length + 1;
    const newKey: ProviderCredentialVersion = {
      providerId: params.providerId,
      keyId: params.newKeyId,
      version,
      publicKeyFingerprint: params.newPublicKeyFingerprint,
      createdAtMs: params.nowMs,
      state: "active",
    };
    keys.push(newKey);

    this.appendEvent({
      eventType: "key_rotated",
      providerId: params.providerId,
      keyId: params.newKeyId,
      actorId: params.actorId,
      reason: `Rotated to ${params.newKeyId} with overlapWindowMs=${params.overlapWindowMs}`,
      timestampMs: params.nowMs,
      effectiveFromSequence: params.sequenceNumber ?? 0,
    });

    return { previousKey, newKey: { ...newKey } };
  }

  /**
   * Revokes a compromised key, quarantines recent readings from that key, and generates
   * a forensic impact report of all consensus decisions and claims influenced by it.
   */
  revokeKeyAndRespond(params: {
    providerId: string;
    keyId: string;
    actorId: string;
    reason: string;
    nowMs: number;
    effectiveFromSequence: number;
    lookbackWindowMs: number;
  }): CompromiseForensicReport {
    if (!params.reason || params.reason.trim() === "") {
      throw new Error("Revocation reason must be non-empty");
    }
    const key = this.findKeyOrThrow(params.providerId, params.keyId);
    key.state = "revoked";

    const ev = this.appendEvent({
      eventType: "key_revoked",
      providerId: params.providerId,
      keyId: params.keyId,
      actorId: params.actorId,
      reason: params.reason.trim(),
      timestampMs: params.nowMs,
      effectiveFromSequence: params.effectiveFromSequence,
    });

    const lookbackStartMs = params.nowMs - Math.max(0, params.lookbackWindowMs);
    const quarantinedReadingIds: string[] = [];

    for (const reading of this.readings.values()) {
      if (
        reading.providerId === params.providerId &&
        reading.keyId === params.keyId &&
        (reading.sequenceNumber >= params.effectiveFromSequence ||
          reading.observedAtMs >= lookbackStartMs)
      ) {
        reading.quarantined = true;
        quarantinedReadingIds.push(reading.readingId);
      }
    }

    const quarantinedSet = new Set(quarantinedReadingIds);
    const affectedDecisionIds: string[] = [];
    const remediationClaimIdSet = new Set<string>();

    for (const dec of this.decisions.values()) {
      const influenced = dec.includedReadingIds.some((rid) => quarantinedSet.has(rid));
      if (influenced) {
        affectedDecisionIds.push(dec.decisionId);
        for (const cid of dec.linkedClaimIds) {
          remediationClaimIdSet.add(cid);
        }
      }
    }

    return {
      revocationEventId: ev.eventId,
      providerId: params.providerId,
      revokedKeyId: params.keyId,
      effectiveFromSequence: params.effectiveFromSequence,
      lookbackStartMs,
      quarantinedReadingIds,
      affectedDecisionIds,
      remediationClaimIds: Array.from(remediationClaimIdSet),
      generatedAtMs: params.nowMs,
    };
  }

  /**
   * Reverses an accidental revocation via an immutable superseding ledger record
   * (never deletes prior revocation records).
   */
  supersedeAccidentalRevocation(params: {
    providerId: string;
    keyId: string;
    supersedesEventId: string;
    actorId: string;
    reason: string;
    nowMs: number;
    effectiveFromSequence: number;
  }): CredentialLedgerEvent {
    const key = this.findKeyOrThrow(params.providerId, params.keyId);
    const priorEvent = this.ledgerEvents.find(
      (e) =>
        e.eventId === params.supersedesEventId &&
        e.eventType === "key_revoked" &&
        e.providerId === params.providerId &&
        e.keyId === params.keyId
    );
    if (!priorEvent) {
      throw new Error(
        `Revocation event "${params.supersedesEventId}" not found for ${params.providerId}:${params.keyId}`
      );
    }

    key.state = "active";
    for (const reading of this.readings.values()) {
      if (reading.providerId === params.providerId && reading.keyId === params.keyId) {
        reading.quarantined = false;
      }
    }

    return this.appendEvent({
      eventType: "revocation_superseded",
      providerId: params.providerId,
      keyId: params.keyId,
      actorId: params.actorId,
      reason: params.reason.trim(),
      timestampMs: params.nowMs,
      effectiveFromSequence: params.effectiveFromSequence,
      supersedesEventId: params.supersedesEventId,
    });
  }

  /**
   * Verifies whether a provider's signing key is accepted at the submission boundary
   * or at consensus round inclusion time (protects against mid-round key revocation).
   */
  verifyCredentialAt(
    providerId: string,
    keyId: string,
    nowMs: number
  ): CredentialVerificationResult {
    const keys = this.keysByProvider.get(providerId);
    if (!keys) {
      return {
        accepted: false,
        providerId,
        keyId,
        rejectionReason: "unknown_provider",
      };
    }

    const key = keys.find((k) => k.keyId === keyId);
    if (!key) {
      return {
        accepted: false,
        providerId,
        keyId,
        rejectionReason: "unknown_key",
      };
    }

    if (key.state === "revoked") {
      return {
        accepted: false,
        providerId,
        keyId,
        rejectionReason: "key_revoked",
      };
    }

    if (key.state === "retired") {
      return {
        accepted: false,
        providerId,
        keyId,
        rejectionReason: "key_retired",
      };
    }

    if (key.state === "rotation_overlap") {
      if (key.overlapExpiresAtMs !== undefined && nowMs > key.overlapExpiresAtMs) {
        key.state = "retired";
        return {
          accepted: false,
          providerId,
          keyId,
          rejectionReason: "rotation_overlap_expired",
        };
      }
      return {
        accepted: true,
        providerId,
        keyId,
      };
    }

    return {
      accepted: true,
      providerId,
      keyId,
    };
  }

  recordReading(reading: Omit<ContributedReadingRecord, "quarantined">): ContributedReadingRecord {
    const check = this.verifyCredentialAt(
      reading.providerId,
      reading.keyId,
      reading.observedAtMs
    );
    if (!check.accepted) {
      throw new Error(
        `Rejected submission from ${reading.providerId}:${reading.keyId} (${check.rejectionReason})`
      );
    }
    const stored: ContributedReadingRecord = {
      ...reading,
      quarantined: false,
    };
    this.readings.set(reading.readingId, stored);
    return stored;
  }

  recordConsensusDecision(decision: ConsensusDecisionEvidenceRecord): void {
    // Mid-round check: ensure none of the included readings were signed by a key that is now revoked
    for (const rid of decision.includedReadingIds) {
      const r = this.readings.get(rid);
      if (!r) {
        throw new Error(`Unknown reading "${rid}" in consensus decision`);
      }
      const check = this.verifyCredentialAt(r.providerId, r.keyId, decision.decidedAtMs);
      if (!check.accepted || r.quarantined) {
        throw new Error(
          `Cannot include reading "${rid}" in consensus decision: key ${r.keyId} is ${check.rejectionReason ?? "quarantined"}`
        );
      }
    }
    this.decisions.set(decision.decisionId, {
      ...decision,
      includedReadingIds: [...decision.includedReadingIds],
      linkedClaimIds: [...decision.linkedClaimIds],
    });
  }

  getLedgerEvents(): readonly CredentialLedgerEvent[] {
    return this.ledgerEvents;
  }

  private findKeyOrThrow(providerId: string, keyId: string): ProviderCredentialVersion {
    const keys = this.keysByProvider.get(providerId);
    const found = keys?.find((k) => k.keyId === keyId);
    if (!found) {
      throw new Error(`Key "${keyId}" not found for provider "${providerId}"`);
    }
    return found;
  }

  private appendEvent(
    params: Omit<CredentialLedgerEvent, "eventId">
  ): CredentialLedgerEvent {
    this.eventSeq += 1;
    const ev: CredentialLedgerEvent = {
      eventId: `cred_ev_${params.timestampMs}_${this.eventSeq}`,
      ...params,
    };
    this.ledgerEvents.push(ev);
    return ev;
  }
}
