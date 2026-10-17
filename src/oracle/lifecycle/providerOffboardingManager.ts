export interface ProviderLifecycleRecord {
  sourceId: string;
  status: "active" | "retired";
  credentialsRevoked: boolean;
  retiredAtMs?: number;
  retentionDays: number;
}

export interface StoredProviderReadingRecord {
  readingId: string;
  sourceId: string;
  observedAtMs: number;
  normalizedValue: number;
  contentHash: string;
  rawPayloadBody: string | null;
  purgedAtMs?: number;
  purgeReason?: string;
}

export class ProviderOffboardingManager {
  private readonly providers = new Map<string, ProviderLifecycleRecord>();
  private readonly readings = new Map<string, StoredProviderReadingRecord>();

  public registerProvider(sourceId: string, retentionDays: number): void {
    this.providers.set(sourceId, {
      sourceId,
      status: "active",
      credentialsRevoked: false,
      retentionDays,
    });
  }

  public addReading(reading: StoredProviderReadingRecord): void {
    this.readings.set(reading.readingId, { ...reading });
  }

  public offboardProvider(sourceId: string, nowMs: number): ProviderLifecycleRecord {
    const prov = this.providers.get(sourceId);
    if (!prov) throw new Error(`Unknown provider '${sourceId}'`);
    prov.status = "retired";
    prov.credentialsRevoked = true;
    prov.retiredAtMs = nowMs;
    return { ...prov };
  }

  public reOnboardProvider(sourceId: string): ProviderLifecycleRecord {
    const prov = this.providers.get(sourceId);
    if (!prov) throw new Error(`Unknown provider '${sourceId}'`);
    prov.status = "active";
    prov.credentialsRevoked = false;
    return { ...prov };
  }

  public purgeExpiredRawPayloads(params: {
    sourceId: string;
    nowMs: number;
    dryRun: boolean;
  }): { eligibleReadingIds: string[]; purgedCount: number } {
    const prov = this.providers.get(params.sourceId);
    if (!prov) throw new Error(`Unknown provider '${params.sourceId}'`);

    const retentionMs = prov.retentionDays * 24 * 60 * 60 * 1_000;
    const eligibleReadingIds: string[] = [];

    for (const reading of this.readings.values()) {
      if (reading.sourceId !== params.sourceId) continue;
      if (reading.rawPayloadBody === null) continue;
      if (params.nowMs - reading.observedAtMs >= retentionMs) {
        eligibleReadingIds.push(reading.readingId);
        if (!params.dryRun) {
          reading.rawPayloadBody = null;
          reading.purgedAtMs = params.nowMs;
          reading.purgeReason = "license_retention_expired";
        }
      }
    }

    return {
      eligibleReadingIds,
      purgedCount: params.dryRun ? 0 : eligibleReadingIds.length,
    };
  }

  public getReading(readingId: string): StoredProviderReadingRecord | undefined {
    const r = this.readings.get(readingId);
    return r ? { ...r } : undefined;
  }
}
