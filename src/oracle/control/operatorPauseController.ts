import { timingSafeEqual } from "node:crypto";

export interface PauseStateEntry {
  scope: string; // coverageType or "GLOBAL_ALL"
  paused: boolean;
  actorId: string;
  reason: string;
  updatedAtMs: number;
}

export interface OperatorPauseAuditRow {
  auditId: number;
  scope: string;
  action: "pause" | "resume";
  actorId: string;
  reason: string;
  priorPausedState: boolean;
  nextPausedState: boolean;
  timestampMs: number;
}

export interface OperatorControlResponse {
  httpStatus: 200 | 400 | 401;
  ok: boolean;
  errorCode: null | "UNAUTHORIZED_OPERATOR" | "REASON_REQUIRED" | "INVALID_SCOPE";
  state: PauseStateEntry | null;
}

export class OperatorPauseController {
  public static readonly GLOBAL_SCOPE = "GLOBAL_ALL";

  private readonly operatorBearerToken: string;
  private readonly knownCoverageTypes: Set<string>;
  private readonly statesByScope = new Map<string, PauseStateEntry>();
  private readonly auditTrail: OperatorPauseAuditRow[] = [];
  private nextAuditId = 1;

  constructor(options: {
    operatorBearerToken: string;
    knownCoverageTypes: string[];
  }) {
    if (!options.operatorBearerToken || options.operatorBearerToken.length < 8) {
      throw new Error("OPERATOR_TOKEN_REQUIRED");
    }
    this.operatorBearerToken = options.operatorBearerToken;
    this.knownCoverageTypes = new Set(options.knownCoverageTypes);
  }

  private isAuthorized(providedToken: string | undefined): boolean {
    if (!providedToken) return false;
    const expectedBuf = Buffer.from(this.operatorBearerToken, "utf8");
    const actualBuf = Buffer.from(providedToken, "utf8");
    return (
      expectedBuf.length === actualBuf.length &&
      timingSafeEqual(expectedBuf, actualBuf)
    );
  }

  public pause(params: {
    providedToken: string | undefined;
    actorId: string;
    scope: string;
    reason: string;
    nowMs?: number;
  }): OperatorControlResponse {
    return this.mutateState({ ...params, action: "pause", targetPaused: true });
  }

  public resume(params: {
    providedToken: string | undefined;
    actorId: string;
    scope: string;
    reason: string;
    nowMs?: number;
  }): OperatorControlResponse {
    return this.mutateState({
      ...params,
      action: "resume",
      targetPaused: false,
    });
  }

  private mutateState(params: {
    providedToken: string | undefined;
    actorId: string;
    scope: string;
    reason: string;
    action: "pause" | "resume";
    targetPaused: boolean;
    nowMs?: number;
  }): OperatorControlResponse {
    const nowMs = params.nowMs ?? Date.now();

    if (!this.isAuthorized(params.providedToken)) {
      return {
        httpStatus: 401,
        ok: false,
        errorCode: "UNAUTHORIZED_OPERATOR",
        state: null,
      };
    }

    if (
      params.scope !== OperatorPauseController.GLOBAL_SCOPE &&
      !this.knownCoverageTypes.has(params.scope)
    ) {
      return {
        httpStatus: 400,
        ok: false,
        errorCode: "INVALID_SCOPE",
        state: null,
      };
    }

    const cleanReason = (params.reason ?? "").trim();
    if (!cleanReason || !params.actorId?.trim()) {
      return {
        httpStatus: 400,
        ok: false,
        errorCode: "REASON_REQUIRED",
        state: null,
      };
    }

    const prior = this.statesByScope.get(params.scope)?.paused ?? false;
    const entry: PauseStateEntry = {
      scope: params.scope,
      paused: params.targetPaused,
      actorId: params.actorId.trim(),
      reason: cleanReason,
      updatedAtMs: nowMs,
    };
    this.statesByScope.set(params.scope, entry);

    this.auditTrail.push({
      auditId: this.nextAuditId++,
      scope: params.scope,
      action: params.action,
      actorId: entry.actorId,
      reason: cleanReason,
      priorPausedState: prior,
      nextPausedState: params.targetPaused,
      timestampMs: nowMs,
    });

    return {
      httpStatus: 200,
      ok: true,
      errorCode: null,
      state: entry,
    };
  }

  /**
   * Evaluates whether a coverage type is paused (either directly or via GLOBAL_ALL).
   * Paused coverage types continue polling/logging so operators can monitor recovery,
   * while on-chain publishing and claim settlement are halted.
   */
  public evaluatePipelineGate(coverageType: string): {
    effectivePaused: boolean;
    allowPollingAndLogging: true;
    allowPublishingAndSettlement: boolean;
    activePauseReason: string | null;
  } {
    const globalState = this.statesByScope.get(
      OperatorPauseController.GLOBAL_SCOPE
    );
    if (globalState?.paused) {
      return {
        effectivePaused: true,
        allowPollingAndLogging: true,
        allowPublishingAndSettlement: false,
        activePauseReason: `[GLOBAL] ${globalState.reason}`,
      };
    }

    const covState = this.statesByScope.get(coverageType);
    if (covState?.paused) {
      return {
        effectivePaused: true,
        allowPollingAndLogging: true,
        allowPublishingAndSettlement: false,
        activePauseReason: covState.reason,
      };
    }

    return {
      effectivePaused: false,
      allowPollingAndLogging: true,
      allowPublishingAndSettlement: true,
      activePauseReason: null,
    };
  }

  public getAuditTrail(): OperatorPauseAuditRow[] {
    return [...this.auditTrail];
  }
}
