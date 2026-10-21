import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { canonicalJson, sha256Hex } from "./canonical";
import { computeConsensus, ConsensusResult } from "./consensus.engine";
import { EVIDENCE_LEDGER, PAYLOAD_STORE } from "./consensus.config";
import { EvidenceLedger, PayloadStore } from "./evidence-ledger";
import { fingerprintReading, loadMirrorDetectionConfig } from "./fingerprint";
import {
  DecisionEvent,
  QuorumPolicyEvent,
  ReadingEvent,
  SignatureStatus,
  SourceStatus,
  SourceVersionEvent,
  TriggerRule,
} from "./evidence.types";
import {
  latestPolicyVersionNumber,
  latestSourceVersionNumber,
  penaltiesAt,
  policyAt,
  readingsAt,
  sourcesAt,
  sourceVersionAt,
} from "./ledger-view";

export interface RegisterSourceInput {
  sourceId: string;
  providerId: string;
  feedId: string;
  status?: SourceStatus;
  weight: number;
  warmupMs?: number;
  retentionDays: number;
  credentialRef?: string;
  declaredUpstream?: string;
}

export interface SetQuorumPolicyInput {
  feedId: string;
  minSources: number;
  expectedSources?: number;
  minTotalWeight: number;
  maxReadingAgeMs: number;
  trigger: TriggerRule;
}

export interface RecordReadingInput {
  feedId: string;
  sourceId: string;
  value: number;
  observedAt: number;
  ledgerSeq?: number;
  /** Raw provider body. Omitted → recorded with payloadHash null (capture failure). */
  rawPayload?: string;
  signature?: SignatureStatus;
}

/**
 * Write side of the consensus evidence layer: versioned source and quorum
 * configuration, reading ingestion, and live decisions.
 *
 * Live decisions use exactly the same pure functions as historical
 * reconstruction (ledger-view + consensus.engine), evaluated at the
 * timestamp the decision is recorded with.
 */
@Injectable()
export class ConsensusService {
  constructor(
    @Inject(EVIDENCE_LEDGER) private readonly ledger: EvidenceLedger,
    @Inject(PAYLOAD_STORE) private readonly payloads: PayloadStore,
  ) {}

  /**
   * Registers a source or records a new version of it. Re-onboarding a
   * retired source is just a new version with a later `effectiveFrom`, so
   * every historical instant still maps to exactly one configuration.
   */
  registerSource(input: RegisterSourceInput): SourceVersionEvent {
    if (!input.sourceId || !input.providerId || !input.feedId) {
      throw new BadRequestException("sourceId, providerId and feedId are required");
    }
    if (!(input.weight >= 0) || !(input.retentionDays >= 0)) {
      throw new BadRequestException("weight and retentionDays must be non-negative");
    }
    const existing = sourceVersionAt(this.ledger.events(), input.sourceId, Number.POSITIVE_INFINITY);
    if (existing && existing.feedId !== input.feedId) {
      throw new BadRequestException(`source ${input.sourceId} belongs to feed ${existing.feedId}`);
    }
    const now = this.ledger.reserveTimestamp();
    return this.ledger.append({
      kind: "source_version",
      sourceId: input.sourceId,
      providerId: input.providerId,
      feedId: input.feedId,
      version: latestSourceVersionNumber(this.ledger.events(), input.sourceId) + 1,
      status: input.status ?? "active",
      weight: input.weight,
      warmupUntil: input.warmupMs ? now + input.warmupMs : undefined,
      retentionDays: input.retentionDays,
      credentialRef: input.credentialRef,
      declaredUpstream: input.declaredUpstream,
      effectiveFrom: now,
      recordedAt: now,
    }) as SourceVersionEvent;
  }

  setQuorumPolicy(input: SetQuorumPolicyInput): QuorumPolicyEvent {
    const expectedSources = input.expectedSources ?? input.minSources;
    if (input.minSources < 1 || expectedSources < input.minSources) {
      throw new BadRequestException("minSources must be ≥ 1 and expectedSources ≥ minSources");
    }
    if (!(input.maxReadingAgeMs > 0)) throw new BadRequestException("maxReadingAgeMs must be > 0");
    const now = this.ledger.reserveTimestamp();
    return this.ledger.append({
      kind: "quorum_policy",
      feedId: input.feedId,
      version: latestPolicyVersionNumber(this.ledger.events(), input.feedId) + 1,
      minSources: input.minSources,
      expectedSources,
      minTotalWeight: input.minTotalWeight,
      maxReadingAgeMs: input.maxReadingAgeMs,
      trigger: input.trigger,
      effectiveFrom: now,
      recordedAt: now,
    }) as QuorumPolicyEvent;
  }

  /**
   * Records a normalised reading and (if supplied) its raw payload body.
   * Idempotent: the reading id is derived from its content, so re-ingesting
   * the same reading returns the original event.
   */
  recordReading(input: RecordReadingInput): ReadingEvent {
    if (!Number.isFinite(input.value) || !Number.isFinite(input.observedAt)) {
      throw new BadRequestException("value and observedAt must be finite numbers");
    }
    const source = sourceVersionAt(this.ledger.events(), input.sourceId, Number.POSITIVE_INFINITY);
    if (!source || source.feedId !== input.feedId) {
      throw new BadRequestException(`unknown source ${input.sourceId} for feed ${input.feedId}`);
    }
    if (source.status === "retired") {
      throw new ConflictException(`source ${input.sourceId} is retired; readings are no longer ingested`);
    }

    let hash: string | null = null;
    if (input.rawPayload !== undefined) {
      hash = this.payloads.put(input.rawPayload);
      const alreadyStored = this.ledger.events().some((e) => e.kind === "payload_stored" && e.hash === hash);
      if (!alreadyStored) {
        this.ledger.append({
          kind: "payload_stored",
          hash,
          sourceId: input.sourceId,
          sizeBytes: Buffer.byteLength(input.rawPayload),
        });
      }
    }

    const readingId = `rd_${sha256Hex(
      canonicalJson({
        feedId: input.feedId,
        sourceId: input.sourceId,
        value: input.value,
        observedAt: input.observedAt,
        payloadHash: hash,
      }),
    ).slice(0, 24)}`;
    const existing = this.ledger.events().find((e) => e.kind === "reading" && e.readingId === readingId);
    if (existing) return existing as ReadingEvent;

    return this.ledger.append({
      kind: "reading",
      readingId,
      feedId: input.feedId,
      sourceId: input.sourceId,
      value: input.value,
      observedAt: input.observedAt,
      ledgerSeq: input.ledgerSeq,
      payloadHash: hash,
      signature: input.signature ?? "not_required",
      fingerprint: fingerprintReading(input.feedId, input.value, input.observedAt, loadMirrorDetectionConfig().bucketMs),
    }) as ReadingEvent;
  }

  recordSignatureResult(readingId: string, result: "verified" | "failed"): void {
    const reading = this.ledger.events().find((e) => e.kind === "reading" && e.readingId === readingId);
    if (!reading) throw new NotFoundException(`unknown reading ${readingId}`);
    this.ledger.append({ kind: "signature_result", readingId, result });
  }

  /** Whether a feed is under consensus governance (has a quorum policy). */
  isGoverned(feedId: string): boolean {
    return policyAt(this.ledger.events(), feedId, this.ledger.now()) !== null;
  }

  /** Computes consensus over everything known right now and records it. */
  decide(feedId: string, ledgerSeq?: number): DecisionEvent {
    const at = this.ledger.reserveTimestamp();
    const result = this.evaluate(feedId, at);
    return this.ledger.append({
      kind: "decision",
      decisionId: `dc_${sha256Hex(`${feedId}:${at}:${this.ledger.events().length}`).slice(0, 24)}`,
      feedId,
      at,
      ledgerSeq,
      outcome: result.outcome,
      value: result.value,
      triggered: result.triggered,
      reason: result.reason,
      policyVersion: result.policyVersion,
      contributing: result.contributing,
      recordedAt: at,
    }) as DecisionEvent;
  }

  /** Read-only consensus evaluation at time t (nothing is recorded). */
  evaluate(feedId: string, t: number): ConsensusResult {
    const events = this.ledger.events();
    return computeConsensus({
      feedId,
      at: t,
      policy: policyAt(events, feedId, t),
      sources: sourcesAt(events, feedId, t),
      readings: readingsAt(events, feedId, t),
      penalties: penaltiesAt(events, feedId, t),
    });
  }
}
