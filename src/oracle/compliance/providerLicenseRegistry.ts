export interface ProviderLicenseEntry {
  sourceId: string;
  licenseType: "open_data" | "commercial" | "proprietary";
  permitRawStorage: boolean;
  permitOnChainDerivedPublication: boolean;
  permitPublicRedistribution: boolean;
  attributionString: string;
  expiresAtMs: number | null;
  documentedGraceExceptionReason?: string;
}

export interface LicenseEvaluationResult {
  sourceId: string;
  state: "active" | "expiring_soon" | "suspended" | "grace_exception";
  daysUntilExpiry: number | null;
  permitRawStorage: boolean;
  permitOnChainDerivedPublication: boolean;
  attributionString: string;
}

export class ProviderLicenseRegistry {
  private readonly entries = new Map<string, ProviderLicenseEntry>();
  private readonly warningLeadDays: number;

  constructor(warningLeadDays = 30) {
    this.warningLeadDays = warningLeadDays;
  }

  public registerLicense(entry: ProviderLicenseEntry): void {
    this.entries.set(entry.sourceId, { ...entry });
  }

  public evaluateSourceLicense(sourceId: string, nowMs: number): LicenseEvaluationResult {
    const entry = this.entries.get(sourceId);
    if (!entry) {
      throw new Error(`No license entry registered for source '${sourceId}'`);
    }

    if (entry.expiresAtMs === null) {
      return {
        sourceId,
        state: "active",
        daysUntilExpiry: null,
        permitRawStorage: entry.permitRawStorage,
        permitOnChainDerivedPublication: entry.permitOnChainDerivedPublication,
        attributionString: entry.attributionString,
      };
    }

    const dayMs = 24 * 60 * 60 * 1_000;
    const daysUntilExpiry = Math.floor((entry.expiresAtMs - nowMs) / dayMs);

    if (nowMs >= entry.expiresAtMs) {
      if (entry.documentedGraceExceptionReason) {
        return {
          sourceId,
          state: "grace_exception",
          daysUntilExpiry,
          permitRawStorage: entry.permitRawStorage,
          permitOnChainDerivedPublication: entry.permitOnChainDerivedPublication,
          attributionString: entry.attributionString,
        };
      }
      return {
        sourceId,
        state: "suspended",
        daysUntilExpiry,
        permitRawStorage: false,
        permitOnChainDerivedPublication: false,
        attributionString: entry.attributionString,
      };
    }

    const state = daysUntilExpiry <= this.warningLeadDays ? "expiring_soon" : "active";
    return {
      sourceId,
      state,
      daysUntilExpiry,
      permitRawStorage: entry.permitRawStorage,
      permitOnChainDerivedPublication: entry.permitOnChainDerivedPublication,
      attributionString: entry.attributionString,
    };
  }
}
