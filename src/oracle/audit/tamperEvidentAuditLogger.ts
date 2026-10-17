import { createHash } from "node:crypto";

export type PrivilegedOracleAction =
  | "FEED_PAUSE"
  | "FEED_RESUME"
  | "FEED_DEFINITION_EDIT"
  | "QUORUM_POLICY_EDIT"
  | "MANUAL_OVERRIDE"
  | "QUARANTINE_RELEASE"
  | "RELAYER_KEY_ROTATION";

export interface ChainedAuditRecord {
  sequenceNumber: number;
  requestId: string;
  actor: string;
  action: PrivilegedOracleAction;
  targetId: string;
  reason: string;
  beforeState: Record<string, unknown>;
  afterState: Record<string, unknown>;
  timestampMs: number;
  prevHash: string;
  entryHash: string;
}

const REDACTED_KEYS = new Set([
  "apikey",
  "api_key",
  "secret",
  "privatekey",
  "private_key",
  "password",
  "authorization",
  "token",
]);

function redactSensitiveFields(
  input: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (REDACTED_KEYS.has(k.toLowerCase())) {
      out[k] = "[REDACTED]";
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = redactSensitiveFields(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function computeAuditHash(
  recordWithoutHash: Omit<ChainedAuditRecord, "entryHash">
): string {
  const canonical = JSON.stringify({
    sequenceNumber: recordWithoutHash.sequenceNumber,
    requestId: recordWithoutHash.requestId,
    actor: recordWithoutHash.actor,
    action: recordWithoutHash.action,
    targetId: recordWithoutHash.targetId,
    reason: recordWithoutHash.reason,
    beforeState: recordWithoutHash.beforeState,
    afterState: recordWithoutHash.afterState,
    timestampMs: recordWithoutHash.timestampMs,
    prevHash: recordWithoutHash.prevHash,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export class TamperEvidentAuditLogger {
  private readonly records: ChainedAuditRecord[] = [];
  private readonly pendingSiemBuffer: ChainedAuditRecord[] = [];
  private readonly siemExporter?: (record: ChainedAuditRecord) => Promise<void>;
  private siemDeliveryFailures = 0;

  constructor(options?: {
    siemExporter?: (record: ChainedAuditRecord) => Promise<void>;
  }) {
    this.siemExporter = options?.siemExporter;
  }

  public async record(params: {
    requestId: string;
    actor: string;
    action: PrivilegedOracleAction;
    targetId: string;
    reason: string;
    beforeState: Record<string, unknown>;
    afterState: Record<string, unknown>;
    timestampMs?: number;
  }): Promise<ChainedAuditRecord> {
    const sequenceNumber = this.records.length + 1;
    const prevHash =
      this.records.length > 0
        ? this.records[this.records.length - 1].entryHash
        : "GENESIS";
    const timestampMs = params.timestampMs ?? Date.now();

    const baseRecord: Omit<ChainedAuditRecord, "entryHash"> = {
      sequenceNumber,
      requestId: params.requestId,
      actor: params.actor,
      action: params.action,
      targetId: params.targetId,
      reason: params.reason,
      beforeState: redactSensitiveFields(params.beforeState),
      afterState: redactSensitiveFields(params.afterState),
      timestampMs,
      prevHash,
    };

    const fullRecord: ChainedAuditRecord = {
      ...baseRecord,
      entryHash: computeAuditHash(baseRecord),
    };

    // Persist locally first so SIEM outages never lose or block audit records
    this.records.push(fullRecord);

    if (this.siemExporter) {
      try {
        await this.siemExporter(fullRecord);
      } catch {
        this.siemDeliveryFailures += 1;
        this.pendingSiemBuffer.push(fullRecord);
      }
    }

    return fullRecord;
  }

  public async flushPendingSiemBuffer(): Promise<{
    flushedCount: number;
    remainingCount: number;
  }> {
    if (!this.siemExporter) {
      return { flushedCount: 0, remainingCount: 0 };
    }

    let flushedCount = 0;
    while (this.pendingSiemBuffer.length > 0) {
      const next = this.pendingSiemBuffer[0];
      try {
        await this.siemExporter(next);
        this.pendingSiemBuffer.shift();
        flushedCount += 1;
      } catch {
        this.siemDeliveryFailures += 1;
        break;
      }
    }

    return {
      flushedCount,
      remainingCount: this.pendingSiemBuffer.length,
    };
  }

  public verifyHashChain(): { valid: boolean; brokenAtSequence: number | null } {
    for (let i = 0; i < this.records.length; i++) {
      const rec = this.records[i];
      const expectedPrev = i === 0 ? "GENESIS" : this.records[i - 1].entryHash;
      if (rec.sequenceNumber !== i + 1 || rec.prevHash !== expectedPrev) {
        return { valid: false, brokenAtSequence: i + 1 };
      }
      if (computeAuditHash(rec) !== rec.entryHash) {
        return { valid: false, brokenAtSequence: i + 1 };
      }
    }
    return { valid: true, brokenAtSequence: null };
  }

  public queryAuditHistory(filter?: {
    targetId?: string;
    actor?: string;
    startMs?: number;
    endMs?: number;
  }): ChainedAuditRecord[] {
    return this.records.filter((r) => {
      if (filter?.targetId && r.targetId !== filter.targetId) return false;
      if (filter?.actor && r.actor !== filter.actor) return false;
      if (filter?.startMs !== undefined && r.timestampMs < filter.startMs) {
        return false;
      }
      if (filter?.endMs !== undefined && r.timestampMs > filter.endMs) {
        return false;
      }
      return true;
    });
  }

  public getSiemMetrics(): {
    pendingCount: number;
    deliveryFailures: number;
  } {
    return {
      pendingCount: this.pendingSiemBuffer.length,
      deliveryFailures: this.siemDeliveryFailures,
    };
  }
}
