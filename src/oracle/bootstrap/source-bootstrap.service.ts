import {
  HistoricalSample,
  SourceBaseline,
  cleanSamples,
  computeBaseline,
  corroborationRate,
  deviationScore,
  historyCoverage,
  seedReputation,
} from "./baseline";
import { BootstrapStatus, BootstrapStore, SourceBootstrapRecord } from "./bootstrap.store";
import { HistoryProviderRegistry } from "./history-providers";

export interface BootstrapSourceSpec {
  sourceId: string;
  /** Adapter type, e.g. "coingecko". Must have a registered history provider. */
  adapter: string;
  /** Adapter settings such as `coinId` or `protocolSlug`. */
  params?: Record<string, string>;
}

export interface BootstrapOptions {
  /** How far back to backfill. */
  lookbackMs?: number;
  /** Expected spacing of history points; used for coverage and corroboration buckets. */
  expectedIntervalMs?: number;
  /** Fewer cleaned samples than this leaves the source in `insufficient_history`. */
  minSamples?: number;
  /** Max deviation from the peer median that still counts as agreement. */
  corroborationToleranceBps?: number;
  /** Re-run even for sources that are already warm. */
  force?: boolean;
  /** Operator or system identity recorded with the result. */
  requestedBy?: string;
}

export interface BootstrapReport {
  feedId: string;
  sourceId: string;
  status: BootstrapStatus;
  /** True when the source was left untouched (already warm, or a run was in flight). */
  skipped: boolean;
  sampleCount: number;
  reputation: number | null;
  coverage: number | null;
  corroboration: number | null;
  error: string | null;
}

export type AnomalyAssessment =
  | { ready: false; status: BootstrapStatus }
  | { ready: true; score: number; anomalous: boolean; baseline: SourceBaseline };

export const BOOTSTRAP_DEFAULTS = {
  lookbackMs: 30 * 24 * 60 * 60 * 1000,
  expectedIntervalMs: 60 * 60 * 1000,
  minSamples: 24,
  corroborationToleranceBps: 100,
  /** Robust z-score above which a live reading is flagged. */
  anomalyThreshold: 6,
} as const;

interface ServiceOptions {
  now?: () => number;
  logger?: { log(message: string): void; warn(message: string): void };
}

const pairKey = (feedId: string, sourceId: string): string => `${feedId}\u0000${sourceId}`;
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Seeds historical readings, statistical baselines, and initial reputation
 * whenever a feed or source adapter is onboarded, so anomaly thresholds,
 * reputation, and corroboration have a reference point from day one.
 *
 * Sources of one feed are bootstrapped together: every history is fetched
 * first, then each source is compared with the others (plus any already-warm
 * sources of the feed) to seed its corroboration rate.
 *
 * Runs are idempotent. Warm sources are skipped unless `force` is set, and a
 * forced re-run that fails keeps the previous warm baseline.
 */
export class SourceBootstrapService {
  private readonly inFlight = new Set<string>();
  private readonly now: () => number;
  private readonly logger?: ServiceOptions["logger"];

  constructor(
    private readonly store: BootstrapStore,
    private readonly providers: HistoryProviderRegistry,
    options: ServiceOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
  }

  bootstrapSource(
    feedId: string,
    source: BootstrapSourceSpec,
    options: BootstrapOptions = {}
  ): Promise<BootstrapReport> {
    return this.bootstrapFeed(feedId, [source], options).then((reports) => reports[0]);
  }

  async bootstrapFeed(
    feedId: string,
    sources: BootstrapSourceSpec[],
    options: BootstrapOptions = {}
  ): Promise<BootstrapReport[]> {
    const settings = {
      lookbackMs: options.lookbackMs ?? BOOTSTRAP_DEFAULTS.lookbackMs,
      expectedIntervalMs: options.expectedIntervalMs ?? BOOTSTRAP_DEFAULTS.expectedIntervalMs,
      minSamples: options.minSamples ?? BOOTSTRAP_DEFAULTS.minSamples,
      toleranceBps: options.corroborationToleranceBps ?? BOOTSTRAP_DEFAULTS.corroborationToleranceBps,
      requestedBy: options.requestedBy ?? null,
    };

    const reports = new Map<string, BootstrapReport>();
    const previous = new Map<string, SourceBootstrapRecord | null>();
    const targets: BootstrapSourceSpec[] = [];

    for (const source of sources) {
      const existing = await this.store.getRecord(feedId, source.sourceId);
      const key = pairKey(feedId, source.sourceId);
      if (this.inFlight.has(key) || (existing?.status === "warm" && !options.force)) {
        reports.set(source.sourceId, this.reportFrom(existing, feedId, source.sourceId, true));
        continue;
      }
      this.inFlight.add(key);
      previous.set(source.sourceId, existing);
      targets.push(source);
    }

    try {
      for (const source of targets) {
        await this.store.saveRecord(
          this.record(feedId, source, settings, { status: "bootstrapping" })
        );
      }

      const to = new Date(this.now());
      const from = new Date(to.getTime() - settings.lookbackMs);
      const fetched = await Promise.all(
        targets.map(async (source) => {
          const provider = this.providers.get(source.adapter);
          if (!provider) {
            return { source, error: `No history provider registered for adapter "${source.adapter}"` };
          }
          try {
            const raw = await provider.fetchHistory({
              feedId,
              sourceId: source.sourceId,
              params: source.params ?? {},
              from,
              to,
            });
            return { source, samples: cleanSamples(raw).filter((s) => s.timestamp >= from.getTime()) };
          } catch (error) {
            return { source, error: message(error) };
          }
        })
      );

      // Peers: everything fetched in this run, plus warm sources of the feed not being re-run.
      const series = new Map<string, HistoricalSample[]>();
      for (const result of fetched) {
        if (result.samples && result.samples.length >= settings.minSamples) {
          series.set(result.source.sourceId, result.samples);
        }
      }
      for (const record of await this.store.listRecords(feedId)) {
        if (record.status === "warm" && !series.has(record.sourceId) && !previous.has(record.sourceId)) {
          series.set(record.sourceId, await this.store.getSeedReadings(feedId, record.sourceId));
        }
      }

      for (const result of fetched) {
        const { source } = result;
        const prior = previous.get(source.sourceId) ?? null;

        if (result.error !== undefined || !result.samples || result.samples.length < settings.minSamples) {
          const status: BootstrapStatus = result.error !== undefined ? "failed" : "insufficient_history";
          const error =
            result.error ??
            `Only ${result.samples?.length ?? 0} usable samples; at least ${settings.minSamples} required`;
          const record =
            prior?.status === "warm"
              ? { ...prior, error: `Re-bootstrap ${status}: ${error}`, updatedAt: new Date(this.now()).toISOString() }
              : this.record(feedId, source, settings, { status, error });
          await this.store.saveRecord(record);
          this.logger?.warn(`Bootstrap of ${feedId}/${source.sourceId} ${status}: ${error}`);
          reports.set(source.sourceId, {
            ...this.reportFrom(record, feedId, source.sourceId, false),
            status: record.status,
            error,
          });
          continue;
        }

        const samples = result.samples;
        const baseline = computeBaseline(samples);
        const coverage = historyCoverage(samples, settings.lookbackMs, settings.expectedIntervalMs);
        const peers = [...series.entries()]
          .filter(([peerId]) => peerId !== source.sourceId)
          .map(([, peerSamples]) => peerSamples);
        const corroboration = corroborationRate(
          samples,
          peers,
          settings.expectedIntervalMs,
          settings.toleranceBps
        );
        const reputation = seedReputation(coverage, corroboration?.rate ?? null);

        await this.store.replaceSeedReadings(feedId, source.sourceId, samples);
        const record = this.record(feedId, source, settings, {
          status: "warm",
          baseline,
          coverage: round4(coverage),
          corroboration: corroboration ? round4(corroboration.rate) : null,
          corroboratedBuckets: corroboration?.comparedBuckets ?? 0,
          reputation,
        });
        await this.store.saveRecord(record);
        this.logger?.log(
          `Bootstrapped ${feedId}/${source.sourceId}: ${samples.length} samples, reputation ${reputation}`
        );
        reports.set(source.sourceId, this.reportFrom(record, feedId, source.sourceId, false));
      }
    } finally {
      for (const source of targets) this.inFlight.delete(pairKey(feedId, source.sourceId));
    }

    return sources.map((source) => reports.get(source.sourceId)!);
  }

  getRecord(feedId: string, sourceId: string): Promise<SourceBootstrapRecord | null> {
    return this.store.getRecord(feedId, sourceId);
  }

  listRecords(feedId?: string): Promise<SourceBootstrapRecord[]> {
    return this.store.listRecords(feedId);
  }

  /**
   * Scores a live reading against the source's seeded baseline. Returns
   * `ready: false` until the source is warm, so callers skip the deviation
   * check explicitly instead of firing on an empty reference.
   */
  async assess(
    feedId: string,
    sourceId: string,
    value: number,
    threshold: number = BOOTSTRAP_DEFAULTS.anomalyThreshold
  ): Promise<AnomalyAssessment> {
    const record = await this.store.getRecord(feedId, sourceId);
    if (!record || record.status !== "warm" || !record.baseline) {
      return { ready: false, status: record?.status ?? "cold" };
    }
    const score = deviationScore(record.baseline, value);
    return { ready: true, score, anomalous: score > threshold, baseline: record.baseline };
  }

  private record(
    feedId: string,
    source: BootstrapSourceSpec,
    settings: { lookbackMs: number; expectedIntervalMs: number; requestedBy: string | null },
    fields: Partial<SourceBootstrapRecord> & { status: BootstrapStatus }
  ): SourceBootstrapRecord {
    return {
      feedId,
      sourceId: source.sourceId,
      adapter: source.adapter,
      baseline: null,
      reputation: null,
      coverage: null,
      corroboration: null,
      corroboratedBuckets: 0,
      lookbackMs: settings.lookbackMs,
      expectedIntervalMs: settings.expectedIntervalMs,
      error: null,
      requestedBy: settings.requestedBy,
      updatedAt: new Date(this.now()).toISOString(),
      ...fields,
    };
  }

  private reportFrom(
    record: SourceBootstrapRecord | null,
    feedId: string,
    sourceId: string,
    skipped: boolean
  ): BootstrapReport {
    return {
      feedId,
      sourceId,
      status: record?.status ?? "cold",
      skipped,
      sampleCount: record?.baseline?.sampleCount ?? 0,
      reputation: record?.reputation ?? null,
      coverage: record?.coverage ?? null,
      corroboration: record?.corroboration ?? null,
      error: record?.error ?? null,
    };
  }
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
