export type ClaimRemedyType =
  | "pay_difference"
  | "reverse_payout"
  | "leave_as_is";

export type RemediationState =
  | "proposed"
  | "approved"
  | "executed"
  | "closed"
  | "rejected";

export interface ClaimRemediationRecord {
  remediationId: string;
  originalClaimId: string;
  invalidatedDecisionId: string;
  remedyType: ClaimRemedyType;
  deltaAmountUsd: number;
  requesterId: string;
  approverId: string | null;
  justification: string;
  status: RemediationState;
  executionTxRef: string | null;
}

export class ClaimRemediationWorkflow {
  private readonly records = new Map<string, ClaimRemediationRecord>();
  private seq = 0;

  public proposeRemediation(params: {
    originalClaimId: string;
    invalidatedDecisionId: string;
    remedyType: ClaimRemedyType;
    deltaAmountUsd: number;
    requesterId: string;
    justification: string;
  }): ClaimRemediationRecord {
    if (!params.justification.trim()) {
      throw new Error("JUSTIFICATION_REQUIRED");
    }
    this.seq += 1;
    const remediationId = `rem-${this.seq}`;
    const record: ClaimRemediationRecord = {
      remediationId,
      originalClaimId: params.originalClaimId,
      invalidatedDecisionId: params.invalidatedDecisionId,
      remedyType: params.remedyType,
      deltaAmountUsd: params.deltaAmountUsd,
      requesterId: params.requesterId,
      approverId: null,
      justification: params.justification,
      status: "proposed",
      executionTxRef: null,
    };
    this.records.set(remediationId, record);
    return { ...record };
  }

  public approveRemediation(params: {
    remediationId: string;
    approverId: string;
  }): ClaimRemediationRecord {
    const rec = this.records.get(params.remediationId);
    if (!rec) throw new Error("UNKNOWN_REMEDIATION");
    if (rec.status !== "proposed") {
      throw new Error(
        `INVALID_STATE_TRANSITION: Cannot approve from '${rec.status}'`
      );
    }

    const movesFunds =
      rec.remedyType === "pay_difference" ||
      rec.remedyType === "reverse_payout";
    if (movesFunds && params.approverId === rec.requesterId) {
      throw new Error(
        "DUAL_CONTROL_VIOLATION: Approver must be distinct from requester for fund-moving remediations"
      );
    }

    rec.approverId = params.approverId;
    rec.status = "approved";
    return { ...rec };
  }

  public executeRemediation(params: {
    remediationId: string;
    executionTxRef: string;
  }): ClaimRemediationRecord {
    const rec = this.records.get(params.remediationId);
    if (!rec) throw new Error("UNKNOWN_REMEDIATION");
    if (rec.status !== "approved") {
      throw new Error(
        `INVALID_STATE_TRANSITION: Cannot execute from '${rec.status}'`
      );
    }
    rec.executionTxRef = params.executionTxRef;
    rec.status = "executed";
    return { ...rec };
  }

  public closeRemediation(remediationId: string): ClaimRemediationRecord {
    const rec = this.records.get(remediationId);
    if (!rec) throw new Error("UNKNOWN_REMEDIATION");
    if (rec.status !== "executed") {
      throw new Error(
        `INVALID_STATE_TRANSITION: Cannot close from '${rec.status}'`
      );
    }
    rec.status = "closed";
    return { ...rec };
  }

  public listOpenRemediations(): ClaimRemediationRecord[] {
    return Array.from(this.records.values()).filter(
      (r) => r.status !== "closed" && r.status !== "rejected"
    );
  }
}
