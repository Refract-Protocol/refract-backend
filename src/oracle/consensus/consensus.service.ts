import { Logger } from "@nestjs/common";
import { SourceObservation } from "../adapters/source-adapter";
import { ObservationResult, OracleSourceRegistry } from "../adapters/source-registry";
import { EvidenceNotDurableError } from "../evidence/evidence-record";
import { OracleEvidenceBuffer } from "../evidence/oracle-evidence-buffer";
import { ConsensusDecision, ConsensusStatus, DecisionInput } from "./consensus-decision";
import { isPastThreshold, TRIGGER_SPECS, TriggerSpec } from "./trigger-specs";

export interface ConsensusOptions {
  /** Minimum independent live sources that must agree. */
  minSources: number;
  /** Source count at which coverage confidence reaches 1. */
  targetSources: number;
  /** Minimum confidence for a decision to be actionable. */
  minConfidence: number;
  /** Decisions are reused for this long so one scan does not refetch per policy. */
  decisionTtlMs: number;
  now?: () => number;
}

/**
 * Produces the consensus decisions that settlement acts on. Nothing else
 * may authorize a payout.
 *
 * For a coverage type it observes the trigger metric from every registered
 * live source, aggregates the usable values (median), and then evaluates:
 *
 *   quorum      enough usable live sources?            → else "insufficient"
 *   agreement   spread within the trigger's maxSpread? → else "conflicted"
 *   confidence  coverage × agreement ≥ minConfidence?  → else not actionable
 *   evidence    decision durably appended to the trail → else "unrecorded"
 *   degradation a registered source failed             → "degraded" (still actionable)
 *
 * Every decision, actionable or not, is written to the evidence trail
 * before it is returned, so each payout can be traced to the exact
 * observations and HTTP evidence behind it.
 */
export class ConsensusService {
  private readonly logger = new Logger(ConsensusService.name);
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; decision: Promise<ConsensusDecision> }>();

  constructor(
    private readonly registry: OracleSourceRegistry,
    private readonly evidence: OracleEvidenceBuffer,
    private readonly options: ConsensusOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Decision for an on-chain coverage type discriminant (0–4). */
  async decide(coverageType: number, subject?: string): Promise<ConsensusDecision> {
    const spec = TRIGGER_SPECS[coverageType];
    if (!spec) throw new Error(`Unknown coverageType ${coverageType}`);

    const key = `${coverageType}|${subject ?? ""}`;
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < this.options.decisionTtlMs) {
      return cached.decision;
    }
    const decision = this.evaluate(spec, subject);
    this.cache.set(key, { at: this.now(), decision });
    decision.catch(() => this.cache.delete(key));
    return decision;
  }

  private async evaluate(spec: TriggerSpec, subject?: string): Promise<ConsensusDecision> {
    const results = spec.metric ? await this.registry.observe({ metric: spec.metric, subject }) : [];
    const usable = this.usableObservations(results);
    const failures = results.flatMap((r) => (r.ok ? [] : [{ sourceId: r.sourceId, reason: r.reason }]));
    const decision = this.aggregate(spec, subject, usable, failures);
    return this.record(decision);
  }

  /**
   * Live, successful observations that count toward quorum. Extension point
   * for per-source filtering before cross-source aggregation.
   */
  protected usableObservations(results: ObservationResult[]): SourceObservation[] {
    return results.flatMap((r) => (r.ok && r.observation.trustTier === "live" ? [r.observation] : []));
  }

  protected aggregate(
    spec: TriggerSpec,
    subject: string | undefined,
    observations: SourceObservation[],
    failures: Array<{ sourceId: string; reason: string }>,
  ): ConsensusDecision {
    const inputs: DecisionInput[] = observations.map((o) => ({
      sourceId: o.sourceId,
      value: o.value,
      observedAt: o.observedAt,
      evidenceSha256: o.evidence.bodySha256,
    }));
    const values = inputs.map((i) => i.value);
    const required = this.options.minSources;
    const quorum = { required, available: values.length, met: values.length >= required };
    const blockers: string[] = [];

    let value: number | null = null;
    let confidence = 0;
    let status: ConsensusStatus;

    if (!spec.metric) {
      status = "insufficient";
      blockers.push(`no live source exists for ${spec.coverageType}`);
    } else if (!quorum.met) {
      status = "insufficient";
      blockers.push(`quorum not met: ${values.length} of ${required} required live source(s)`);
    } else {
      value = median(values);
      const spread = Math.max(...values) - Math.min(...values);
      const agreement = spec.maxSpread > 0 ? Math.max(0, 1 - spread / spec.maxSpread) : spread === 0 ? 1 : 0;
      const coverage = Math.min(1, values.length / this.options.targetSources);
      confidence = round(coverage * agreement, 4);

      if (spread > spec.maxSpread) {
        status = "conflicted";
        blockers.push(`sources disagree: spread ${round(spread, 6)} exceeds ${spec.maxSpread}`);
      } else {
        status = failures.length > 0 ? "degraded" : "ok";
      }
      if (confidence < this.options.minConfidence) {
        blockers.push(`confidence ${confidence} below required ${this.options.minConfidence}`);
      }
    }

    return {
      id: `${spec.coverageType}@pending`,
      coverageType: spec.coverageType,
      metric: spec.metric,
      subject,
      value,
      threshold: spec.threshold,
      direction: spec.direction,
      triggered: value !== null && isPastThreshold(value, spec),
      actionable: blockers.length === 0,
      status,
      confidence,
      quorum,
      inputs,
      failures,
      blockers,
      decidedAt: this.now(),
      evidenceSeq: null,
    };
  }

  /** Writes the decision to the evidence trail. A decision that cannot be recorded is never actionable. */
  private async record(decision: ConsensusDecision): Promise<ConsensusDecision> {
    try {
      const [seq] = await this.evidence.append([
        {
          kind: "decision",
          coverageType: decision.coverageType,
          value: decision.value ?? decision.threshold,
          severity: decision.actionable && decision.triggered ? "triggered" : "low",
          source: "consensus",
          recordedAt: decision.decidedAt,
          payload: decision,
        },
      ]);
      return { ...decision, id: `${decision.coverageType}@${seq}`, evidenceSeq: seq };
    } catch (err) {
      const detail = err instanceof EvidenceNotDurableError ? err.message : String(err);
      this.logger.error(`Consensus decision for ${decision.coverageType} not recorded; blocking settlement: ${detail}`);
      return {
        ...decision,
        id: `${decision.coverageType}@unrecorded`,
        status: "unrecorded",
        actionable: false,
        blockers: [...decision.blockers, "decision could not be written to the evidence trail"],
      };
    }
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
