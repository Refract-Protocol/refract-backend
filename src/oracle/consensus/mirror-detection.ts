import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { MetricsService } from "../../metrics/metrics.service";
import { sha256Hex } from "./canonical";
import { EVIDENCE_LEDGER } from "./consensus.config";
import { EvidenceLedger } from "./evidence-ledger";
import { EvidenceEvent, IndependencePenaltyEvent } from "./evidence.types";
import { analyseFeed, MirrorDetectionConfig, PairAnalysis } from "./fingerprint";
import { penaltiesAt, readingsAt, sourcesAt } from "./ledger-view";

export const MIRROR_CONFIG = Symbol("MIRROR_CONFIG");

export interface MirrorPlan {
  feedId: string;
  windowStart: number;
  windowEnd: number;
  analyses: PairAnalysis[];
  apply: PairAnalysis[];
  clear: { penalty: IndependencePenaltyEvent; analysis: PairAnalysis | null }[];
}

/** Feeds under consensus governance (have ever had a quorum policy). */
export function governedFeeds(events: readonly EvidenceEvent[]): string[] {
  return [...new Set(events.flatMap((e) => (e.kind === "quorum_policy" ? [e.feedId] : [])))].sort();
}

/**
 * Pure planning step shared by the scheduled scan (which applies the plan)
 * and the backtest CLI (which only reports it).
 *
 * - A pair flagged as mirrored with no active penalty → apply.
 * - An active penalty whose pair, given enough informative samples, no
 *   longer matches → clear. Too little movement to judge keeps the penalty.
 *   A quiet market is not evidence of independence.
 */
export function planMirrorActions(
  events: readonly EvidenceEvent[],
  feedId: string,
  now: number,
  cfg: MirrorDetectionConfig,
): MirrorPlan {
  const windowStart = now - cfg.windowMs;
  const retired = new Set(sourcesAt(events, feedId, now).filter((s) => s.status === "retired").map((s) => s.sourceId));
  const readings = readingsAt(events, feedId, now, windowStart).filter((r) => !retired.has(r.sourceId));
  const analyses = analyseFeed(feedId, readings, cfg);
  const active = penaltiesAt(events, feedId, now);
  const key = (a: string, b: string) => `${a}|${b}`;
  const activeByPair = new Map(active.map((p) => [key(p.sourceA, p.sourceB), p]));
  const analysisByPair = new Map(analyses.map((a) => [key(a.sourceA, a.sourceB), a]));

  const apply = analyses.filter((a) => a.mirrored && !activeByPair.has(key(a.sourceA, a.sourceB)));
  const clear = active.flatMap((penalty): MirrorPlan["clear"] => {
    if (retired.has(penalty.sourceA) || retired.has(penalty.sourceB)) return [{ penalty, analysis: null }];
    const analysis = analysisByPair.get(key(penalty.sourceA, penalty.sourceB));
    if (analysis && !analysis.mirrored && analysis.informativeSamples >= cfg.minInformativeSamples) {
      return [{ penalty, analysis }];
    }
    return [];
  });
  return { feedId, windowStart, windowEnd: now, analyses, apply, clear };
}

/**
 * Periodic batch scan for cloned or mirrored sources. It runs off the
 * consensus hot path. Findings are persisted as `independence_penalty`
 * events, which consensus applies from then on and reconstruction replays.
 */
@Injectable()
export class MirrorDetectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MirrorDetectionService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(EVIDENCE_LEDGER) private readonly ledger: EvidenceLedger,
    @Inject(MIRROR_CONFIG) private readonly cfg: MirrorDetectionConfig,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      try {
        this.scan();
      } catch (err) {
        this.logger.error(`Mirror scan failed: ${err instanceof Error ? err.message : err}`);
      }
    }, this.cfg.scanIntervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  scan(): { applied: number; cleared: number } {
    const summary = { applied: 0, cleared: 0 };
    const now = this.ledger.now();
    for (const feedId of governedFeeds(this.ledger.events())) {
      const plan = planMirrorActions(this.ledger.events(), feedId, now, this.cfg);
      for (const a of plan.apply) {
        const penaltyId = `mp_${sha256Hex(`${feedId}:${a.sourceA}:${a.sourceB}:${now}`).slice(0, 20)}`;
        this.ledger.append({
          kind: "independence_penalty",
          penaltyId,
          feedId,
          sourceA: a.sourceA,
          sourceB: a.sourceB,
          factor: this.cfg.penaltyFactor,
          windowStart: plan.windowStart,
          windowEnd: plan.windowEnd,
          lagBuckets: a.lagBuckets,
          informativeSamples: a.informativeSamples,
          matches: a.matches,
          exactMatches: a.exactMatches,
          matchRatio: a.matchRatio,
          evidence: a.evidence,
        });
        this.ledger.append({
          kind: "audit",
          action: "mirror_detection.penalty_applied",
          actor: "system",
          reason: `${a.sourceA} and ${a.sourceB} matched in ${a.matches}/${a.informativeSamples} moving buckets (lag ${a.lagBuckets})`,
          details: { penaltyId, feedId, sourceA: a.sourceA, sourceB: a.sourceB, factor: this.cfg.penaltyFactor },
        });
        this.metrics?.recordMirrorPenaltyChange(feedId, "applied");
        this.logger.warn(`Suspected mirror on ${feedId}: ${a.sourceA} ↔ ${a.sourceB} (ratio ${a.matchRatio}); penalty applied`);
        summary.applied++;
      }
      for (const { penalty, analysis } of plan.clear) {
        const reason = analysis
          ? `pair diverged: ${analysis.matches}/${analysis.informativeSamples} moving buckets matched`
          : "a source in the pair was retired";
        this.ledger.append({
          kind: "independence_penalty_cleared",
          penaltyId: penalty.penaltyId,
          feedId,
          sourceA: penalty.sourceA,
          sourceB: penalty.sourceB,
          reason,
          matchRatio: analysis?.matchRatio ?? 0,
          informativeSamples: analysis?.informativeSamples ?? 0,
        });
        this.ledger.append({
          kind: "audit",
          action: "mirror_detection.penalty_cleared",
          actor: "system",
          reason,
          details: { penaltyId: penalty.penaltyId, feedId },
        });
        this.metrics?.recordMirrorPenaltyChange(feedId, "cleared");
        summary.cleared++;
      }
      this.metrics?.recordSuspectedMirrorPairs(feedId, penaltiesAt(this.ledger.events(), feedId, this.ledger.now()).length);
    }
    return summary;
  }

  /**
   * Operator trust-status view: each feed's sources with declared provenance
   * and the active mirror penalties with their supporting evidence. Operators
   * use it to cross-check on-chain provenance and licences.
   */
  trustStatus() {
    const events = this.ledger.events();
    const now = this.ledger.now();
    return {
      generatedAt: new Date(now).toISOString(),
      thresholds: this.cfg,
      feeds: governedFeeds(events).map((feedId) => {
        const penalties = penaltiesAt(events, feedId, now);
        const shadowed = new Set(penalties.flatMap((p) => [p.sourceA, p.sourceB]));
        return {
          feedId,
          sources: sourcesAt(events, feedId, now).map((s) => ({
            sourceId: s.sourceId,
            providerId: s.providerId,
            status: s.status,
            weight: s.weight,
            declaredUpstream: s.declaredUpstream ?? null,
            suspectedMirror: shadowed.has(s.sourceId),
          })),
          suspectedMirrors: penalties.map((p) => ({
            penaltyId: p.penaltyId,
            sourceA: p.sourceA,
            sourceB: p.sourceB,
            factor: p.factor,
            detectedAt: new Date(p.recordedAt).toISOString(),
            window: { start: new Date(p.windowStart).toISOString(), end: new Date(p.windowEnd).toISOString() },
            lagBuckets: p.lagBuckets,
            matchRatio: p.matchRatio,
            informativeSamples: p.informativeSamples,
            exactMatches: p.exactMatches,
            evidence: p.evidence,
          })),
        };
      }),
    };
  }
}
