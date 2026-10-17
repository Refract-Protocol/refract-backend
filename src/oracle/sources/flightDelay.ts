export type FlightOperationalStatus =
  | "on_time"
  | "delayed"
  | "cancelled"
  | "diverted";

export interface RawAviationProviderFlight {
  flightIata: string;
  departureAirportIata: string;
  arrivalAirportIata: string;
  scheduledArrivalIso: string;
  actualOrEstimatedArrivalIso?: string;
  cancelled?: boolean;
  diverted?: boolean;
  arrivalTimezoneOffsetMinutes?: number;
}

export interface FlightStatusReading {
  coverageType: "flight_delay";
  isMocked: false;
  provenance: string;
  flightIata: string;
  scheduledArrivalDateLocal: string;
  operationalStatus: FlightOperationalStatus;
  delayMinutes: number;
  encodedContractDelayValue: number;
  exceedsPayoutThreshold: boolean;
  observedAtMs: number;
  fromCache: boolean;
}

export type FlightDelayFetchOutcome =
  | { status: "ok"; reading: FlightStatusReading }
  | {
      status: "no_reading";
      reason: "unknown_flight" | "rate_limited" | "provider_unavailable";
    };

export interface LiveFlightDelayAdapterConfig {
  providerName: string;
  apiKey: string | undefined;
  enabled: boolean;
  payoutDelayThresholdMinutes?: number;
  cancelledSyntheticDelayMinutes?: number;
  divertedSyntheticDelayMinutes?: number;
  cacheTtlMs?: number;
  fetchFlightFromProvider: (params: {
    flightIata: string;
    departureDateIso: string;
    apiKey: string;
  }) => Promise<RawAviationProviderFlight | null>;
}

function formatLocalDate(
  utcMs: number,
  timezoneOffsetMinutes: number = 0
): string {
  const shifted = new Date(utcMs + timezoneOffsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 10);
}

export class LiveFlightDelayAdapter {
  private readonly config: LiveFlightDelayAdapterConfig;
  private readonly apiKey: string;
  private readonly payoutThresholdMinutes: number;
  private readonly cancelledSyntheticMinutes: number;
  private readonly divertedSyntheticMinutes: number;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<
    string,
    { expiresAtMs: number; reading: FlightStatusReading }
  >();

  constructor(config: LiveFlightDelayAdapterConfig) {
    if (
      config.enabled &&
      (!config.apiKey || config.apiKey.trim().length < 8)
    ) {
      throw new Error(
        `LiveFlightDelayAdapter startup validation failed: missing or invalid API key for aviation provider ${config.providerName}`
      );
    }

    this.config = config;
    this.apiKey = (config.apiKey ?? "").trim();
    this.payoutThresholdMinutes = config.payoutDelayThresholdMinutes ?? 120;
    this.cancelledSyntheticMinutes =
      config.cancelledSyntheticDelayMinutes ?? 9_999;
    this.divertedSyntheticMinutes =
      config.divertedSyntheticDelayMinutes ?? 8_888;
    this.cacheTtlMs = config.cacheTtlMs ?? 60_000;
  }

  public getCatalogMetadata(): {
    coverageType: "flight_delay";
    isMocked: false;
    providerName: string;
    payoutDelayThresholdMinutes: number;
  } {
    return {
      coverageType: "flight_delay",
      isMocked: false,
      providerName: this.config.providerName,
      payoutDelayThresholdMinutes: this.payoutThresholdMinutes,
    };
  }

  public async fetchFlightStatus(
    flightIata: string,
    departureDateIso: string,
    nowMs: number = Date.now()
  ): Promise<FlightDelayFetchOutcome> {
    const normalizedFlight = flightIata.trim().toUpperCase();
    const cacheKey = `${normalizedFlight}:${departureDateIso}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAtMs > nowMs) {
      return {
        status: "ok",
        reading: {
          ...cached.reading,
          fromCache: true,
        },
      };
    }

    let raw: RawAviationProviderFlight | null;
    try {
      raw = await this.config.fetchFlightFromProvider({
        flightIata: normalizedFlight,
        departureDateIso,
        apiKey: this.apiKey,
      });
    } catch (err) {
      // Scrub API key if accidentally present in upstream error message
      const rawMsg = err instanceof Error ? err.message : "";
      const safeMsg = this.apiKey
        ? rawMsg.split(this.apiKey).join("[REDACTED]")
        : rawMsg;
      const isRateLimit =
        safeMsg.toLowerCase().includes("429") ||
        safeMsg.toLowerCase().includes("rate limit");
      return {
        status: "no_reading",
        reason: isRateLimit ? "rate_limited" : "provider_unavailable",
      };
    }

    // Never treat an unknown flight number as zero delay
    if (!raw) {
      return {
        status: "no_reading",
        reason: "unknown_flight",
      };
    }

    const scheduledMs = Date.parse(raw.scheduledArrivalIso);
    if (!Number.isFinite(scheduledMs)) {
      return {
        status: "no_reading",
        reason: "provider_unavailable",
      };
    }

    const scheduledArrivalDateLocal = formatLocalDate(
      scheduledMs,
      raw.arrivalTimezoneOffsetMinutes ?? 0
    );

    let operationalStatus: FlightOperationalStatus = "on_time";
    let delayMinutes = 0;
    let encodedContractDelayValue = 0;

    if (raw.cancelled) {
      operationalStatus = "cancelled";
      delayMinutes = this.cancelledSyntheticMinutes;
      encodedContractDelayValue = this.cancelledSyntheticMinutes;
    } else if (raw.diverted) {
      operationalStatus = "diverted";
      delayMinutes = this.divertedSyntheticMinutes;
      encodedContractDelayValue = this.divertedSyntheticMinutes;
    } else if (raw.actualOrEstimatedArrivalIso) {
      const actualMs = Date.parse(raw.actualOrEstimatedArrivalIso);
      if (!Number.isFinite(actualMs)) {
        return {
          status: "no_reading",
          reason: "provider_unavailable",
        };
      }
      delayMinutes = Math.max(
        0,
        Math.round((actualMs - scheduledMs) / 60_000)
      );
      encodedContractDelayValue = delayMinutes;
      operationalStatus = delayMinutes > 0 ? "delayed" : "on_time";
    }

    const exceedsPayoutThreshold =
      operationalStatus === "cancelled" ||
      operationalStatus === "diverted" ||
      delayMinutes >= this.payoutThresholdMinutes;

    const reading: FlightStatusReading = {
      coverageType: "flight_delay",
      isMocked: false,
      provenance: this.config.providerName,
      flightIata: normalizedFlight,
      scheduledArrivalDateLocal,
      operationalStatus,
      delayMinutes,
      encodedContractDelayValue,
      exceedsPayoutThreshold,
      observedAtMs: nowMs,
      fromCache: false,
    };

    this.cache.set(cacheKey, {
      expiresAtMs: nowMs + this.cacheTtlMs,
      reading,
    });

    return {
      status: "ok",
      reading,
    };
  }
}
