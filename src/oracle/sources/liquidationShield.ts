export interface RawNexusLiquidationEvent {
  eventId: string;
  pagingToken: string;
  ledger: number;
  ledgerClosedAtMs: number;
  contractId: string;
  vaultId: string;
  liquidatedCollateralUsd: number;
  debtCoveredUsd: number;
  collateralizationRatioBps: number;
}

export interface NexusRpcBatchResponse {
  latestLedger: number;
  events: RawNexusLiquidationEvent[];
}

export interface LiquidationShieldEncodedReading {
  coverageType: "liquidation_shield";
  isMocked: false;
  provenance: "nexus_soroban_events";
  totalLiquidatedCollateralUsd: number;
  minObservedHealthBps: number;
  encodedContractValueScaled: bigint;
  confirmedEventIds: string[];
  finalizedUpToLedger: number;
  observedAtMs: number;
}

export type LiquidationShieldPollOutcome =
  | {
      status: "ok";
      reading: LiquidationShieldEncodedReading;
      cursorSaved: string;
    }
  | {
      status: "no_reading";
      reason: "no_confirmed_events" | "rpc_unavailable" | "rate_limited";
      cursorSaved?: string;
    };

export interface NexusLiquidationAdapterConfig {
  nexusContractId: string;
  minConfirmationDepth: number;
  initialCursor?: string;
  fetchEventsFromRpc: (params: {
    contractId: string;
    cursor?: string;
  }) => Promise<NexusRpcBatchResponse>;
}

export class NexusLiquidationShieldAdapter {
  private readonly config: NexusLiquidationAdapterConfig;
  private persistedCursor: string | undefined;
  private lastFinalizedLedger = 0;
  private readonly processedEventIds = new Set<string>();

  constructor(config: NexusLiquidationAdapterConfig) {
    if (!config.nexusContractId || config.minConfirmationDepth < 1) {
      throw new Error(
        "NexusLiquidationShieldAdapter requires valid nexusContractId and minConfirmationDepth >= 1"
      );
    }
    this.config = config;
    this.persistedCursor = config.initialCursor;
  }

  public getCatalogMetadata(): {
    coverageType: "liquidation_shield";
    isMocked: false;
    provenance: "nexus_soroban_events";
    contractId: string;
    minConfirmationDepth: number;
  } {
    return {
      coverageType: "liquidation_shield",
      isMocked: false,
      provenance: "nexus_soroban_events",
      contractId: this.config.nexusContractId,
      minConfirmationDepth: this.config.minConfirmationDepth,
    };
  }

  public getPersistedCursor(): string | undefined {
    return this.persistedCursor;
  }

  public async pollNextReading(): Promise<LiquidationShieldPollOutcome> {
    let batch: NexusRpcBatchResponse;
    try {
      batch = await this.config.fetchEventsFromRpc({
        contractId: this.config.nexusContractId,
        cursor: this.persistedCursor,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message.toLowerCase() : "";
      const isRateLimit = msg.includes("429") || msg.includes("rate limit");
      return {
        status: "no_reading",
        reason: isRateLimit ? "rate_limited" : "rpc_unavailable",
        cursorSaved: this.persistedCursor,
      };
    }

    const maxConfirmedLedger =
      batch.latestLedger - this.config.minConfirmationDepth;

    // Detect chain rollback if maxConfirmedLedger regressed below our last finalized ledger
    if (maxConfirmedLedger < this.lastFinalizedLedger) {
      return {
        status: "no_reading",
        reason: "no_confirmed_events",
        cursorSaved: this.persistedCursor,
      };
    }

    const confirmedEvents: RawNexusLiquidationEvent[] = [];
    let nextCursor = this.persistedCursor;

    const sortedEvents = [...batch.events].sort((a, b) => a.ledger - b.ledger);

    for (const ev of sortedEvents) {
      if (ev.contractId !== this.config.nexusContractId) {
        continue;
      }
      // Stop advancing cursor at the first unconfirmed event so we re-fetch it once confirmed
      if (ev.ledger > maxConfirmedLedger) {
        break;
      }
      nextCursor = ev.pagingToken;
      if (this.processedEventIds.has(ev.eventId)) {
        continue;
      }
      if (
        !Number.isFinite(ev.liquidatedCollateralUsd) ||
        ev.liquidatedCollateralUsd < 0 ||
        !Number.isFinite(ev.collateralizationRatioBps)
      ) {
        continue;
      }

      this.processedEventIds.add(ev.eventId);
      confirmedEvents.push(ev);
    }

    this.persistedCursor = nextCursor;

    if (confirmedEvents.length === 0) {
      return {
        status: "no_reading",
        reason: "no_confirmed_events",
        cursorSaved: this.persistedCursor,
      };
    }

    let totalLiquidatedUsd = 0;
    let minHealthBps = Number.POSITIVE_INFINITY;
    let maxLedger = this.lastFinalizedLedger;
    let latestObservedAtMs = 0;

    for (const ev of confirmedEvents) {
      totalLiquidatedUsd += ev.liquidatedCollateralUsd;
      if (ev.collateralizationRatioBps < minHealthBps) {
        minHealthBps = ev.collateralizationRatioBps;
      }
      if (ev.ledger > maxLedger) {
        maxLedger = ev.ledger;
      }
      if (ev.ledgerClosedAtMs > latestObservedAtMs) {
        latestObservedAtMs = ev.ledgerClosedAtMs;
      }
    }

    this.lastFinalizedLedger = maxLedger;

    // Scale USD to 7-decimal stroop-like integer for Soroban i128/u128 contract compatibility
    const encodedContractValueScaled = BigInt(
      Math.round(totalLiquidatedUsd * 1e7)
    );

    return {
      status: "ok",
      cursorSaved: this.persistedCursor ?? "",
      reading: {
        coverageType: "liquidation_shield",
        isMocked: false,
        provenance: "nexus_soroban_events",
        totalLiquidatedCollateralUsd: Number(totalLiquidatedUsd.toFixed(6)),
        minObservedHealthBps: minHealthBps,
        encodedContractValueScaled,
        confirmedEventIds: confirmedEvents.map((e) => e.eventId),
        finalizedUpToLedger: maxLedger,
        observedAtMs: latestObservedAtMs,
      },
    };
  }
}
