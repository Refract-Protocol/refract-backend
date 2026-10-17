export type SimulationFailureCategory =
  | "config_or_auth_error"
  | "transient_rpc_error"
  | "invalid_reading_error";

export interface OraclePublishIntent {
  feedId: string;
  roundId: number;
  value: number;
  observedAtMs: number;
  contractAddress: string;
  signerPublicKey: string;
}

export interface SorobanSimulationResponse {
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
  cpuInstructions?: number;
  estimatedFeeStroops?: number;
  readWriteFootprintKeys?: string[];
  assembledTxXdr?: string;
}

export interface PublishPipelineDecision {
  status: "submitted" | "blocked_by_simulation";
  signed: boolean;
  submitted: boolean;
  txHash?: string;
  usedCachedSimulation: boolean;
  failureCategory?: SimulationFailureCategory;
  shouldRetry: boolean;
  retryBackoffMs?: number;
  shouldAlertOperator: boolean;
  quarantinedReading: boolean;
  footprintChangedWarning: boolean;
  unexpectedFootprintKeys: string[];
  evidenceDiagnostic: {
    simulatedOk: boolean;
    errorCode?: string;
    failureCategory?: SimulationFailureCategory;
    cpuInstructions?: number;
    estimatedFeeStroops?: number;
    footprintChangedWarning: boolean;
  };
}

export interface PublishSimulatorMetrics {
  simulatedOkCount: number;
  simulationBlockedCount: number;
  cacheHitCount: number;
  blockedByCategory: Record<SimulationFailureCategory, number>;
}

export interface PublishSimulatorDependencies {
  simulateTransaction: (
    intent: OraclePublishIntent
  ) => Promise<SorobanSimulationResponse>;
  signTransaction: (assembledTxXdr: string, signerPublicKey: string) => Promise<string>;
  submitTransaction: (signedTxXdr: string) => Promise<{ txHash: string }>;
}

export interface PublishSimulatorOptions {
  expectedFootprintKeysByFeed?: Record<string, string[]>;
  simulationCacheTtlMs?: number;
  baseRetryBackoffMs?: number;
}

const CONFIG_OR_AUTH_CODES = new Set([
  "UNAUTHORIZED_SIGNER",
  "CONTRACT_NOT_FOUND",
  "INVALID_ADMIN_AUTH",
  "HOST_AUTH_FAILED",
]);

const TRANSIENT_RPC_CODES = new Set([
  "RPC_TIMEOUT",
  "LEDGER_STATE_LAG",
  "RPC_RATE_LIMITED",
  "NETWORK_UNAVAILABLE",
]);

export function classifySimulationFailure(
  errorCode?: string,
  errorMessage?: string
): SimulationFailureCategory {
  const normalizedCode = (errorCode ?? "").toUpperCase();
  const normalizedMsg = (errorMessage ?? "").toUpperCase();

  if (
    CONFIG_OR_AUTH_CODES.has(normalizedCode) ||
    normalizedMsg.includes("UNAUTHORIZED") ||
    normalizedMsg.includes("CONTRACT_NOT_FOUND")
  ) {
    return "config_or_auth_error";
  }

  if (
    TRANSIENT_RPC_CODES.has(normalizedCode) ||
    normalizedMsg.includes("TIMEOUT") ||
    normalizedMsg.includes("RATE_LIMIT")
  ) {
    return "transient_rpc_error";
  }

  return "invalid_reading_error";
}

export class SorobanPublishSimulator {
  private readonly deps: PublishSimulatorDependencies;
  private readonly expectedFootprintKeysByFeed: Record<string, Set<string>>;
  private readonly simulationCacheTtlMs: number;
  private readonly baseRetryBackoffMs: number;
  private readonly cache = new Map<
    string,
    { expiresAtMs: number; response: SorobanSimulationResponse }
  >();

  private readonly metrics: PublishSimulatorMetrics = {
    simulatedOkCount: 0,
    simulationBlockedCount: 0,
    cacheHitCount: 0,
    blockedByCategory: {
      config_or_auth_error: 0,
      transient_rpc_error: 0,
      invalid_reading_error: 0,
    },
  };

  constructor(
    deps: PublishSimulatorDependencies,
    options?: PublishSimulatorOptions
  ) {
    this.deps = deps;
    this.simulationCacheTtlMs = options?.simulationCacheTtlMs ?? 5_000;
    this.baseRetryBackoffMs = options?.baseRetryBackoffMs ?? 1_500;
    this.expectedFootprintKeysByFeed = {};

    if (options?.expectedFootprintKeysByFeed) {
      for (const [feedId, keys] of Object.entries(
        options.expectedFootprintKeysByFeed
      )) {
        this.expectedFootprintKeysByFeed[feedId] = new Set(keys);
      }
    }
  }

  public async executePublishPipeline(
    intent: OraclePublishIntent,
    nowMs: number = Date.now(),
    attemptNumber: number = 1
  ): Promise<PublishPipelineDecision> {
    const cacheKey = `${intent.contractAddress}:${intent.feedId}:${intent.roundId}:${intent.value}:${intent.observedAtMs}`;
    const cached = this.cache.get(cacheKey);

    let simResponse: SorobanSimulationResponse;
    let usedCachedSimulation = false;

    if (cached && cached.expiresAtMs > nowMs) {
      simResponse = cached.response;
      usedCachedSimulation = true;
      this.metrics.cacheHitCount += 1;
    } else {
      simResponse = await this.deps.simulateTransaction(intent);
      this.cache.set(cacheKey, {
        expiresAtMs: nowMs + this.simulationCacheTtlMs,
        response: simResponse,
      });
    }

    const expectedKeys = this.expectedFootprintKeysByFeed[intent.feedId];
    const unexpectedFootprintKeys: string[] = [];
    if (expectedKeys && simResponse.readWriteFootprintKeys) {
      for (const key of simResponse.readWriteFootprintKeys) {
        if (!expectedKeys.has(key)) {
          unexpectedFootprintKeys.push(key);
        }
      }
    }
    const footprintChangedWarning = unexpectedFootprintKeys.length > 0;

    if (!simResponse.ok) {
      const category = classifySimulationFailure(
        simResponse.errorCode,
        simResponse.errorMessage
      );
      this.metrics.simulationBlockedCount += 1;
      this.metrics.blockedByCategory[category] += 1;

      const shouldRetry = category === "transient_rpc_error";
      const retryBackoffMs = shouldRetry
        ? this.baseRetryBackoffMs * Math.pow(2, Math.max(0, attemptNumber - 1))
        : undefined;

      return {
        status: "blocked_by_simulation",
        signed: false,
        submitted: false,
        usedCachedSimulation,
        failureCategory: category,
        shouldRetry,
        retryBackoffMs,
        shouldAlertOperator: category === "config_or_auth_error",
        quarantinedReading: category === "invalid_reading_error",
        footprintChangedWarning,
        unexpectedFootprintKeys,
        evidenceDiagnostic: {
          simulatedOk: false,
          errorCode: simResponse.errorCode,
          failureCategory: category,
          cpuInstructions: simResponse.cpuInstructions,
          estimatedFeeStroops: simResponse.estimatedFeeStroops,
          footprintChangedWarning,
        },
      };
    }

    this.metrics.simulatedOkCount += 1;
    const assembledXdr =
      simResponse.assembledTxXdr ??
      `assembled:${intent.feedId}:${intent.roundId}`;

    const signedXdr = await this.deps.signTransaction(
      assembledXdr,
      intent.signerPublicKey
    );
    const { txHash } = await this.deps.submitTransaction(signedXdr);

    return {
      status: "submitted",
      signed: true,
      submitted: true,
      txHash,
      usedCachedSimulation,
      shouldRetry: false,
      shouldAlertOperator: false,
      quarantinedReading: false,
      footprintChangedWarning,
      unexpectedFootprintKeys,
      evidenceDiagnostic: {
        simulatedOk: true,
        cpuInstructions: simResponse.cpuInstructions,
        estimatedFeeStroops: simResponse.estimatedFeeStroops,
        footprintChangedWarning,
      },
    };
  }

  public getMetrics(): PublishSimulatorMetrics {
    return {
      simulatedOkCount: this.metrics.simulatedOkCount,
      simulationBlockedCount: this.metrics.simulationBlockedCount,
      cacheHitCount: this.metrics.cacheHitCount,
      blockedByCategory: { ...this.metrics.blockedByCategory },
    };
  }
}
