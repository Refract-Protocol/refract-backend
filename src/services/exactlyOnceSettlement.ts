import { createHash } from "node:crypto";

export type SettlementRecordState =
  | "pending"
  | "submitted"
  | "confirmed"
  | "failed";

export interface DeterministicDecisionKeyInput {
  feedId: string;
  policyId: string;
  conditionRuleKey: string;
  windowStartMs: number;
  windowEndMs: number;
}

export interface DurableSettlementRecord {
  decisionDedupeKey: string;
  policyId: string;
  feedId: string;
  evidenceId: string;
  payoutAmountUsd: number;
  state: SettlementRecordState;
  txHash?: string;
  attemptCount: number;
  updatedAtMs: number;
  lastError?: string;
}

export interface SettlementExecutionResult {
  decisionDedupeKey: string;
  status:
    | "confirmed_new_submission"
    | "reconciled_existing_on_chain_submission"
    | "suppressed_duplicate"
    | "submission_failed_recoverable";
  txHash?: string;
  record: DurableSettlementRecord;
}

export interface ExactlyOnceSettlementDependencies {
  checkOnChainTransactionByDedupeKey: (
    decisionDedupeKey: string
  ) => Promise<{ foundOnChain: boolean; txHash?: string }>;
  submitSettlementOnChain: (params: {
    decisionDedupeKey: string;
    policyId: string;
    payoutAmountUsd: number;
  }) => Promise<{ txHash: string }>;
}

export function deriveDeterministicDecisionId(
  input: DeterministicDecisionKeyInput
): string {
  const canonical = [
    input.feedId.trim().toLowerCase(),
    input.policyId.trim().toLowerCase(),
    input.conditionRuleKey.trim().toLowerCase(),
    String(input.windowStartMs),
    String(input.windowEndMs),
  ].join("|");

  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `dec-idemp-${digest.slice(0, 32)}`;
}

export class ExactlyOnceSettlementCoordinator {
  private readonly recordsByDedupeKey = new Map<
    string,
    DurableSettlementRecord
  >();
  private readonly confirmedDedupeKeyByPolicy = new Map<string, string>();
  private readonly inFlightLocks = new Map<
    string,
    Promise<SettlementExecutionResult>
  >();
  private readonly deps: ExactlyOnceSettlementDependencies;
  private suppressedDuplicateCount = 0;

  constructor(deps: ExactlyOnceSettlementDependencies) {
    this.deps = deps;
  }

  public async settleDecisionIdempotently(params: {
    keyInput: DeterministicDecisionKeyInput;
    evidenceId: string;
    payoutAmountUsd: number;
    nowMs?: number;
  }): Promise<SettlementExecutionResult> {
    const decisionDedupeKey = deriveDeterministicDecisionId(params.keyInput);

    // Coalesce concurrent handlers firing the exact same decision
    const existingInFlight = this.inFlightLocks.get(decisionDedupeKey);
    if (existingInFlight) {
      this.suppressedDuplicateCount += 1;
      const completed = await existingInFlight;
      return {
        decisionDedupeKey,
        status: "suppressed_duplicate",
        txHash: completed.txHash,
        record: { ...completed.record },
      };
    }

    const promise = this.executeProtectedSettlement(
      decisionDedupeKey,
      params.keyInput,
      params.evidenceId,
      params.payoutAmountUsd,
      params.nowMs ?? Date.now()
    );
    this.inFlightLocks.set(decisionDedupeKey, promise);

    try {
      return await promise;
    } finally {
      this.inFlightLocks.delete(decisionDedupeKey);
    }
  }

  public getSuppressedDuplicateCount(): number {
    return this.suppressedDuplicateCount;
  }

  public getSettlementRecord(
    decisionDedupeKey: string
  ): DurableSettlementRecord | undefined {
    const rec = this.recordsByDedupeKey.get(decisionDedupeKey);
    return rec ? { ...rec } : undefined;
  }

  private async executeProtectedSettlement(
    decisionDedupeKey: string,
    keyInput: DeterministicDecisionKeyInput,
    evidenceId: string,
    payoutAmountUsd: number,
    nowMs: number
  ): Promise<SettlementExecutionResult> {
    // 1. Check if policy or decisionDedupeKey is already confirmed in durable store
    const existingPolicyKey = this.confirmedDedupeKeyByPolicy.get(
      keyInput.policyId
    );
    if (existingPolicyKey) {
      this.suppressedDuplicateCount += 1;
      const existingRec = this.recordsByDedupeKey.get(existingPolicyKey)!;
      return {
        decisionDedupeKey,
        status: "suppressed_duplicate",
        txHash: existingRec.txHash,
        record: { ...existingRec },
      };
    }

    let rec = this.recordsByDedupeKey.get(decisionDedupeKey);
    if (rec && rec.state === "confirmed") {
      this.suppressedDuplicateCount += 1;
      return {
        decisionDedupeKey,
        status: "suppressed_duplicate",
        txHash: rec.txHash,
        record: { ...rec },
      };
    }

    if (!rec) {
      rec = {
        decisionDedupeKey,
        policyId: keyInput.policyId,
        feedId: keyInput.feedId,
        evidenceId,
        payoutAmountUsd,
        state: "pending",
        attemptCount: 0,
        updatedAtMs: nowMs,
      };
      this.recordsByDedupeKey.set(decisionDedupeKey, rec);
    }

    // 2. Pre-submission on-chain check (handles post-crash or post-timeout recovery)
    const onChainCheck =
      await this.deps.checkOnChainTransactionByDedupeKey(decisionDedupeKey);
    if (onChainCheck.foundOnChain && onChainCheck.txHash) {
      rec.state = "confirmed";
      rec.txHash = onChainCheck.txHash;
      rec.updatedAtMs = nowMs;
      this.confirmedDedupeKeyByPolicy.set(keyInput.policyId, decisionDedupeKey);
      return {
        decisionDedupeKey,
        status: "reconciled_existing_on_chain_submission",
        txHash: onChainCheck.txHash,
        record: { ...rec },
      };
    }

    // 3. Transition to submitted and invoke on-chain settlement
    rec.state = "submitted";
    rec.attemptCount += 1;
    rec.updatedAtMs = nowMs;

    try {
      const submitted = await this.deps.submitSettlementOnChain({
        decisionDedupeKey,
        policyId: keyInput.policyId,
        payoutAmountUsd,
      });

      rec.state = "confirmed";
      rec.txHash = submitted.txHash;
      rec.lastError = undefined;
      rec.updatedAtMs = nowMs;
      this.confirmedDedupeKeyByPolicy.set(keyInput.policyId, decisionDedupeKey);

      return {
        decisionDedupeKey,
        status: "confirmed_new_submission",
        txHash: submitted.txHash,
        record: { ...rec },
      };
    } catch (err) {
      rec.state = "failed";
      rec.lastError = err instanceof Error ? err.message : "Unknown RPC failure";
      rec.updatedAtMs = nowMs;
      return {
        decisionDedupeKey,
        status: "submission_failed_recoverable",
        record: { ...rec },
      };
    }
  }
}
