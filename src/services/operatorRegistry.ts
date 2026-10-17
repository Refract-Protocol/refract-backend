import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export type OperatorLifecycleStatus =
  | "pending"
  | "active"
  | "suspended"
  | "exited";

export interface OperatorRecord {
  operatorId: string;
  submissionPublicKeyPem: string;
  supportedFeedKeys: string[];
  registeredAtMs: number;
  status: OperatorLifecycleStatus;
  lastSyncedLedger?: number;
}

export interface SignedOperatorRegistrationRequest {
  operatorId: string;
  submissionPublicKeyPem: string;
  supportedFeedKeys: string[];
  requestedAtMs: number;
  nonce: string;
  signatureBase64: string;
}

export interface OperatorRegistryAuditEntry {
  auditId: string;
  operatorId: string;
  action:
    | "registered"
    | "status_changed"
    | "key_rotated"
    | "reconciled_from_chain";
  previousStatus?: OperatorLifecycleStatus;
  newStatus?: OperatorLifecycleStatus;
  detail: string;
  timestampMs: number;
}

export interface OperatorAttributedReading {
  operatorId: string;
  feedKey: string;
  value: number;
  observedAtMs: number;
}

export function serializeOperatorRegistrationMessage(
  req: Omit<SignedOperatorRegistrationRequest, "signatureBase64">
): string {
  const sortedFeeds = [...req.supportedFeedKeys].sort();
  return JSON.stringify({
    feeds: sortedFeeds,
    nonce: req.nonce,
    operator_id: req.operatorId,
    public_key: req.submissionPublicKeyPem.trim(),
    requested_at: req.requestedAtMs,
  });
}

export function signOperatorRegistrationRequest(
  req: Omit<SignedOperatorRegistrationRequest, "signatureBase64">,
  privateKeyPem: string
): SignedOperatorRegistrationRequest {
  const canonical = serializeOperatorRegistrationMessage(req);
  const privKey = createPrivateKey(privateKeyPem);
  const sig = sign(null, Buffer.from(canonical, "utf8"), privKey);
  return {
    ...req,
    signatureBase64: sig.toString("base64"),
  };
}

export class OperatorIdentityRegistry {
  private readonly operators = new Map<string, OperatorRecord>();
  private readonly operatorByPubKey = new Map<string, string>();
  private readonly usedNonces = new Set<string>();
  private readonly auditTrail: OperatorRegistryAuditEntry[] = [];
  private readonly maxRegistrationAgeMs: number;
  private seq = 0;

  constructor(options?: { maxRegistrationAgeMs?: number }) {
    this.maxRegistrationAgeMs = options?.maxRegistrationAgeMs ?? 5 * 60 * 1_000;
  }

  public registerOperator(
    req: SignedOperatorRegistrationRequest,
    nowMs: number = Date.now()
  ): OperatorRecord {
    if (
      !req.operatorId ||
      !req.submissionPublicKeyPem ||
      !Array.isArray(req.supportedFeedKeys) ||
      req.supportedFeedKeys.length === 0 ||
      !req.nonce
    ) {
      throw new Error("INVALID_REGISTRATION_PAYLOAD");
    }

    const ageMs = nowMs - req.requestedAtMs;
    if (ageMs > this.maxRegistrationAgeMs || ageMs < -5_000) {
      throw new Error("STALE_OR_FUTURE_REGISTRATION_REQUEST");
    }

    const nonceKey = `${req.operatorId}:${req.nonce}`;
    if (this.usedNonces.has(nonceKey)) {
      throw new Error("REPLAYED_REGISTRATION_NONCE");
    }

    if (this.operators.has(req.operatorId)) {
      throw new Error("OPERATOR_ALREADY_REGISTERED");
    }

    const normalizedPubKey = req.submissionPublicKeyPem.trim();
    const existingOwner = this.operatorByPubKey.get(normalizedPubKey);
    if (existingOwner) {
      throw new Error("DUPLICATE_SUBMISSION_KEY");
    }

    const canonical = serializeOperatorRegistrationMessage(req);
    let keyVerified = false;
    try {
      const pubKey = createPublicKey(normalizedPubKey);
      keyVerified = verify(
        null,
        Buffer.from(canonical, "utf8"),
        pubKey,
        Buffer.from(req.signatureBase64, "base64")
      );
    } catch {
      keyVerified = false;
    }

    if (!keyVerified) {
      throw new Error("KEY_POSSESSION_VERIFICATION_FAILED");
    }

    this.usedNonces.add(nonceKey);
    const record: OperatorRecord = {
      operatorId: req.operatorId,
      submissionPublicKeyPem: normalizedPubKey,
      supportedFeedKeys: [...new Set(req.supportedFeedKeys)].sort(),
      registeredAtMs: nowMs,
      status: "pending",
    };

    this.operators.set(req.operatorId, record);
    this.operatorByPubKey.set(normalizedPubKey, req.operatorId);
    this.appendAudit({
      operatorId: req.operatorId,
      action: "registered",
      newStatus: "pending",
      detail: `Registered with ${record.supportedFeedKeys.length} feed(s)`,
      timestampMs: nowMs,
    });

    return { ...record };
  }

  public updateOperatorStatus(
    operatorId: string,
    newStatus: OperatorLifecycleStatus,
    reason: string,
    nowMs: number = Date.now()
  ): OperatorRecord {
    const record = this.operators.get(operatorId);
    if (!record) {
      throw new Error(`UNKNOWN_OPERATOR:${operatorId}`);
    }
    const previousStatus = record.status;
    record.status = newStatus;

    this.appendAudit({
      operatorId,
      action: "status_changed",
      previousStatus,
      newStatus,
      detail: reason,
      timestampMs: nowMs,
    });

    return { ...record };
  }

  public filterOperatorAttributedReadingsForQuorum(
    feedKey: string,
    readings: OperatorAttributedReading[],
    minOperatorQuorum: number
  ): {
    quorumSatisfied: boolean;
    eligibleReadings: OperatorAttributedReading[];
    excludedReadings: Array<{
      reading: OperatorAttributedReading;
      reason:
        | "unregistered_operator"
        | "operator_not_active"
        | "unauthorized_feed"
        | "duplicate_operator_in_window";
    }>;
  } {
    const excludedReadings: Array<{
      reading: OperatorAttributedReading;
      reason:
        | "unregistered_operator"
        | "operator_not_active"
        | "unauthorized_feed"
        | "duplicate_operator_in_window";
    }> = [];

    const freshestByOperator = new Map<string, OperatorAttributedReading>();

    for (const r of readings) {
      if (r.feedKey !== feedKey) continue;
      const op = this.operators.get(r.operatorId);
      if (!op) {
        excludedReadings.push({ reading: r, reason: "unregistered_operator" });
        continue;
      }
      if (op.status !== "active") {
        excludedReadings.push({ reading: r, reason: "operator_not_active" });
        continue;
      }
      if (!op.supportedFeedKeys.includes(feedKey)) {
        excludedReadings.push({ reading: r, reason: "unauthorized_feed" });
        continue;
      }

      const existing = freshestByOperator.get(r.operatorId);
      if (!existing) {
        freshestByOperator.set(r.operatorId, r);
      } else if (r.observedAtMs > existing.observedAtMs) {
        excludedReadings.push({
          reading: existing,
          reason: "duplicate_operator_in_window",
        });
        freshestByOperator.set(r.operatorId, r);
      } else {
        excludedReadings.push({
          reading: r,
          reason: "duplicate_operator_in_window",
        });
      }
    }

    const eligibleReadings = Array.from(freshestByOperator.values());
    return {
      quorumSatisfied: eligibleReadings.length >= minOperatorQuorum,
      eligibleReadings,
      excludedReadings,
    };
  }

  public reconcileFromChainSnapshot(
    chainRecords: OperatorRecord[],
    ledgerSeq: number,
    nowMs: number = Date.now()
  ): { updatedCount: number } {
    let updatedCount = 0;
    for (const onChain of chainRecords) {
      const local = this.operators.get(onChain.operatorId);
      const changed =
        !local ||
        local.status !== onChain.status ||
        local.submissionPublicKeyPem !== onChain.submissionPublicKeyPem.trim() ||
        local.supportedFeedKeys.join(",") !==
          [...onChain.supportedFeedKeys].sort().join(",");

      if (changed) {
        if (local) {
          this.operatorByPubKey.delete(local.submissionPublicKeyPem);
        }
        const synced: OperatorRecord = {
          ...onChain,
          submissionPublicKeyPem: onChain.submissionPublicKeyPem.trim(),
          supportedFeedKeys: [...onChain.supportedFeedKeys].sort(),
          lastSyncedLedger: ledgerSeq,
        };
        this.operators.set(synced.operatorId, synced);
        this.operatorByPubKey.set(
          synced.submissionPublicKeyPem,
          synced.operatorId
        );
        this.appendAudit({
          operatorId: synced.operatorId,
          action: "reconciled_from_chain",
          previousStatus: local?.status,
          newStatus: synced.status,
          detail: `Reconciled at ledger ${ledgerSeq}`,
          timestampMs: nowMs,
        });
        updatedCount += 1;
      }
    }
    return { updatedCount };
  }

  public getOperator(operatorId: string): OperatorRecord | undefined {
    const rec = this.operators.get(operatorId);
    return rec ? { ...rec } : undefined;
  }

  public getAuditTrail(): OperatorRegistryAuditEntry[] {
    return this.auditTrail.map((a) => ({ ...a }));
  }

  private appendAudit(
    entry: Omit<OperatorRegistryAuditEntry, "auditId">
  ): void {
    this.seq += 1;
    this.auditTrail.push({
      auditId: `aud-${this.seq}`,
      ...entry,
    });
  }
}
