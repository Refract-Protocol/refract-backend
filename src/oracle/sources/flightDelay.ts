/**
 * Live FlightDelay trigger source (issue #181).
 *
 * Providers are swappable: each one normalizes its response into a
 * FlightStatusReading, and everything downstream only sees that shape. Changing
 * FLIGHT_DELAY_PROVIDER selects a different provider without touching the
 * monitor loop.
 *
 * Encoding contract (matches oracle-encoding.ts: FlightDelay = integer minutes):
 *   - value = whole minutes between scheduled and actual arrival, floored and
 *     never negative (early arrivals report 0).
 *   - cancelled, diverted, in-progress, and unknown flights produce NO value.
 *     They are not delays and must never be published as 0.
 *
 * Timezone: delay math compares epoch instants parsed from ISO-8601 offsets, so
 * it is independent of the host timezone and of DST. Matching a provider record
 * to the requested flight date uses the arrival airport's IANA timezone.
 */

export type FlightStatus = "landed" | "cancelled" | "diverted" | "in_progress" | "unknown";

export interface FlightStatusReading {
  flightNumber: string;
  status: FlightStatus;
  /** ISO-8601 scheduled arrival at the destination airport, with offset. */
  scheduledArrival: string | null;
  /** ISO-8601 actual arrival at the destination airport, with offset. */
  actualArrival: string | null;
  /** Destination airport IANA timezone (e.g. "Europe/London"). */
  arrivalTimeZone: string | null;
  /** Set only when status is "landed". */
  delayMinutes: number | null;
}

export interface FlightStatusProvider {
  readonly id: string;
  /**
   * @param flightNumber IATA flight designator, e.g. "BA117".
   * @param arrivalDate  Scheduled arrival date at the destination airport,
   *                     local calendar date "YYYY-MM-DD".
   */
  fetchFlightStatus(flightNumber: string, arrivalDate: string): Promise<FlightStatusReading>;
}

/** Thrown when the provider reports a rate limit. Carries the wait before retrying. */
export class ProviderRateLimitError extends Error {
  constructor(
    readonly providerId: string,
    readonly retryAfterMs: number,
  ) {
    super(`${providerId} rate limited; retry after ${retryAfterMs}ms`);
    this.name = "ProviderRateLimitError";
  }
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<FetchResponse>;

const FLIGHT_NUMBER_PATTERN = /^[A-Z0-9]{2}\d{1,4}[A-Z]?$/;
const DEFAULT_RETRY_AFTER_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export function normalizeFlightNumber(input: string): string {
  const normalized = input.replace(/\s+/g, "").toUpperCase();
  if (!FLIGHT_NUMBER_PATTERN.test(normalized)) {
    throw new Error("Invalid flight number: expected an IATA designator such as BA117");
  }
  return normalized;
}

/** Whole minutes from scheduled to actual, floored, clamped at 0. */
export function delayMinutesBetween(scheduledIso: string, actualIso: string): number | null {
  const scheduled = Date.parse(scheduledIso);
  const actual = Date.parse(actualIso);
  if (Number.isNaN(scheduled) || Number.isNaN(actual)) {
    return null;
  }
  return Math.max(0, Math.floor((actual - scheduled) / 60_000));
}

/** Calendar date ("YYYY-MM-DD") of an instant in the given IANA timezone. */
export function localDateAt(iso: string, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, which is the format callers compare against.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** Oracle value for a reading, or null when the flight has no determinable delay. */
export function flightDelayOracleValue(reading: FlightStatusReading): number | null {
  if (reading.status !== "landed" || reading.delayMinutes === null) {
    return null;
  }
  return reading.delayMinutes;
}

interface AviationStackFlight {
  flight_status?: string | null;
  flight?: { iata?: string | null } | null;
  arrival?: {
    scheduled?: string | null;
    actual?: string | null;
    timezone?: string | null;
  } | null;
}

interface AviationStackResponse {
  data?: AviationStackFlight[];
  error?: { code?: string } | null;
}

/**
 * AviationStack flights endpoint (free tier available with an API key).
 * The access key is sent as a query parameter, so URLs and response bodies are
 * never included in thrown error messages.
 */
export class AviationStackProvider implements FlightStatusProvider {
  readonly id = "aviationstack";
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike,
    baseUrl = "https://api.aviationstack.com/v1",
  ) {
    this.baseUrl = baseUrl;
  }

  async fetchFlightStatus(flightNumber: string, arrivalDate: string): Promise<FlightStatusReading> {
    const flight = normalizeFlightNumber(flightNumber);
    const url = new URL(`${this.baseUrl}/flights`);
    url.searchParams.set("access_key", this.apiKey);
    url.searchParams.set("flight_iata", flight);

    const response = await this.fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status === 429) {
      throw new ProviderRateLimitError(this.id, parseRetryAfterMs(response.headers.get("retry-after")));
    }
    if (!response.ok) {
      throw new Error(`${this.id} request failed with HTTP ${response.status}`);
    }

    const body = (await response.json()) as AviationStackResponse;
    if (body.error) {
      throw new Error(`${this.id} returned error${body.error.code ? ` ${body.error.code}` : ""}`);
    }

    const match = (body.data ?? []).find(
      (entry) =>
        entry.flight?.iata?.toUpperCase() === flight &&
        entry.arrival?.scheduled != null &&
        entry.arrival.timezone != null &&
        localDateAt(entry.arrival.scheduled, entry.arrival.timezone) === arrivalDate,
    );

    // No record for this flight on this date: unknown, never a zero delay.
    if (!match?.arrival?.scheduled || !match.arrival.timezone) {
      return unknownReading(flight);
    }

    const base = {
      flightNumber: flight,
      scheduledArrival: match.arrival.scheduled,
      actualArrival: match.arrival.actual ?? null,
      arrivalTimeZone: match.arrival.timezone,
    };

    if (match.flight_status === "cancelled") {
      return { ...base, status: "cancelled", delayMinutes: null };
    }
    if (match.flight_status === "diverted") {
      return { ...base, status: "diverted", delayMinutes: null };
    }

    if (!match.arrival.actual) {
      return { ...base, status: "in_progress", delayMinutes: null };
    }

    const delayMinutes = delayMinutesBetween(match.arrival.scheduled, match.arrival.actual);
    if (delayMinutes === null) {
      return unknownReading(flight);
    }
    return { ...base, status: "landed", delayMinutes };
  }
}

/**
 * Placeholder for a paid flight-status provider. Selectable so a paid provider
 * can be dropped in later without changing callers; fails loudly until then.
 */
export class PaidFlightProviderStub implements FlightStatusProvider {
  readonly id = "paid-stub";

  async fetchFlightStatus(): Promise<FlightStatusReading> {
    throw new Error("paid-stub flight-status provider is not implemented");
  }
}

/**
 * Caches per-flight responses for `ttlMs` (align this with the oracle polling
 * interval) and backs off for the provider's Retry-After window after a rate
 * limit, so repeated polls never hammer a rate-limited API.
 */
export class FlightDelaySource {
  private readonly cache = new Map<string, { reading: FlightStatusReading; expiresAt: number }>();
  private backoffUntil = 0;

  constructor(
    private readonly provider: FlightStatusProvider,
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async read(flightNumber: string, arrivalDate: string): Promise<FlightStatusReading> {
    const flight = normalizeFlightNumber(flightNumber);
    const key = `${flight}|${arrivalDate}`;

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) {
      return cached.reading;
    }

    const waitMs = this.backoffUntil - this.now();
    if (waitMs > 0) {
      throw new ProviderRateLimitError(this.provider.id, waitMs);
    }

    try {
      const reading = await this.provider.fetchFlightStatus(flight, arrivalDate);
      this.cache.set(key, { reading, expiresAt: this.now() + this.ttlMs });
      return reading;
    } catch (error) {
      if (error instanceof ProviderRateLimitError) {
        this.backoffUntil = this.now() + error.retryAfterMs;
      }
      throw error;
    }
  }
}

/**
 * Builds the configured provider from env. Returns null when FlightDelay is
 * disabled (FLIGHT_DELAY_PROVIDER unset). Throws at startup when the selected
 * provider is missing credentials, so misconfiguration surfaces at boot rather
 * than at first claim.
 */
export function createFlightDelayProvider(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): FlightStatusProvider | null {
  const providerId = (env.FLIGHT_DELAY_PROVIDER ?? "").trim().toLowerCase();
  if (!providerId) {
    return null;
  }

  switch (providerId) {
    case "aviationstack": {
      const apiKey = (env.AVIATIONSTACK_API_KEY ?? "").trim();
      if (!apiKey) {
        throw new Error(
          "FLIGHT_DELAY_PROVIDER=aviationstack requires AVIATIONSTACK_API_KEY; set it or unset FLIGHT_DELAY_PROVIDER",
        );
      }
      return new AviationStackProvider(apiKey, fetchImpl);
    }
    case "paid-stub":
      return new PaidFlightProviderStub();
    default:
      throw new Error(`Unknown FLIGHT_DELAY_PROVIDER: ${providerId}`);
  }
}

function unknownReading(flightNumber: string): FlightStatusReading {
  return {
    flightNumber,
    status: "unknown",
    scheduledArrival: null,
    actualArrival: null,
    arrivalTimeZone: null,
    delayMinutes: null,
  };
}

function parseRetryAfterMs(header: string | null): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : DEFAULT_RETRY_AFTER_MS;
}
