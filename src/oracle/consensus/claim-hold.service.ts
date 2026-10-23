import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { sha256Hex } from "./canonical";
import { CONSENSUS_CONFIG, ConsensusConfig, EVIDENCE_LEDGER, PAYLOAD_STORE } from "./consensus.config";
import { ConsensusService } from "./consensus.service";
import { assessEvidenceCompleteness, describeGaps } from "./evidence-completeness";
import { EvidenceLedger, PayloadStore } from "./evidence-ledger";
import {
  DecisionEvent,
  EvidenceEvent,
  EvidenceGap,
  HoldDisposition,
  HoldEscalationReason,
} from "./evidence.types";
import { decisionById } from "./ledger-view";

/**
 * Explicit claim states. `payout_held` is not a denial: it means "the
 * verdict says pay, but the evidence behind it is not complete yet".
 *
 *   payout_held ──(evidence complete, verdict stands)──▶ released ──▶ settled
 *        │  ▲
 *        │  └──────────(operator: extend_hold)──────────┐
 *        ▼                                               │
 *   escalated ──(operator: approve_payout)──▶ approved ──▶ settled
 *        └─────(operator: deny)─────────────▶ denied
 */
export type HoldStatus = "payout_held" | "released" | "escalated" | "approved" | "denied" | "settled";

export interface ClaimHold {
  holdId: string;
  policyId: string;
  holder: string;
  feedId: string;
  /** Decision that originally triggered the hold. */
  decisionId: string;
  /** Decision the hold was last evaluated against. */
  currentDecisionId: string;
  status: HoldStatus;
  gaps: EvidenceGap[];
  reason: string;
  placedAt: number;
  deadline: number;
  policyExpiresAt: number;
  escalation: HoldEscalationReason | null;
  disposition: { disposition: HoldDisposition; actor: string; note: string; at: number } | null;
  updatedAt: number;
}

export interface HoldCandidate {
  policyId: string;
  holder: string;
  feedId: string;
  /** ms epoch */
  policyExpiresAt: number;
}

export type GateResult =
  | { action: "proceed"; holdId?: string }
  | { action: "block"; reason: string; holdId?: string };

/** Coverage-type index → consensus feed id. */
export const COVERAGE_FEEDS = [
  "StablecoinDepeg",
  "MarketCrash",
  "LiquidationShield",
  "SmartContractRisk",
  "FlightDelay",
] as const;

const TERMINAL: ReadonlySet<HoldStatus> = new Set(["settled", "denied"]);

/** Folds hold events into current hold state. Pure. */
export function foldHolds(events: readonly EvidenceEvent[]): Map<string, ClaimHold> {
  const holds = new Map<string, ClaimHold>();
  for (const e of events) {
    switch (e.kind) {
      case "hold_placed":
        holds.set(e.holdId, {
          holdId: e.holdId,
          policyId: e.policyId,
          holder: e.holder,
          feedId: e.feedId,
          decisionId: e.decisionId,
          currentDecisionId: e.decisionId,
          status: "payout_held",
          gaps: e.gaps,
          reason: e.reason,
          placedAt: e.recordedAt,
          deadline: e.deadline,
          policyExpiresAt: e.policyExpiresAt,
          escalation: null,
          disposition: null,
          updatedAt: e.recordedAt,
        });
        break;
      case "hold_reevaluated":
        patch(holds, e.holdId, { currentDecisionId: e.decisionId, gaps: e.gaps, reason: describeGaps(e.gaps), updatedAt: e.recordedAt });
        break;
      case "hold_released":
        patch(holds, e.holdId, { status: "released", currentDecisionId: e.decisionId, gaps: [], reason: e.reason, updatedAt: e.recordedAt });
        break;
      case "hold_escalated":
        patch(holds, e.holdId, { status: "escalated", escalation: e.escalation, reason: e.reason, updatedAt: e.recordedAt });
        break;
      case "hold_disposed": {
        const status: HoldStatus =
          e.disposition === "approve_payout" ? "approved" : e.disposition === "deny" ? "denied" : "payout_held";
        const disposition = { disposition: e.disposition, actor: e.actor, note: e.note, at: e.recordedAt };
        patch(holds, e.holdId, {
          status,
          disposition,
          ...(e.disposition === "extend_hold" && e.deadline ? { deadline: e.deadline, escalation: null } : {}),
          updatedAt: e.recordedAt,
        });
        break;
      }
      case "hold_settled":
        patch(holds, e.holdId, { status: "settled", updatedAt: e.recordedAt });
        break;
      default:
        break;
    }
  }
  return holds;
}

function patch(holds: Map<string, ClaimHold>, id: string, fields: Partial<ClaimHold>): void {
  const h = holds.get(id);
  if (h) holds.set(id, { ...h, ...fields });
}

/**
 * Automatic payout holds for triggered decisions whose evidence is incomplete.
 *
 * All state lives in the evidence ledger (hold_* events plus matching audit
 * events), so a restart rebuilds the queue and every transition is part of
 * the evidence record.
 */
@Injectable()
export class ClaimHoldService {
  private readonly logger = new Logger(ClaimHoldService.name);

  constructor(
    @Inject(EVIDENCE_LEDGER) private readonly ledger: EvidenceLedger,
    @Inject(PAYLOAD_STORE) private readonly payloads: PayloadStore,
    @Inject(CONSENSUS_CONFIG) private readonly config: ConsensusConfig,
    private readonly consensus: ConsensusService,
  ) {}

  list(status?: HoldStatus): ClaimHold[] {
    return [...foldHolds(this.ledger.events()).values()]
      .filter((h) => !status || h.status === status)
      .sort((a, b) => a.placedAt - b.placedAt);
  }

  get(holdId: string): ClaimHold {
    const hold = foldHolds(this.ledger.events()).get(holdId);
    if (!hold) throw new NotFoundException(`unknown hold ${holdId}`);
    return hold;
  }

  /** Latest non-terminal hold for a policy, if any. */
  activeHoldFor(policyId: string): ClaimHold | undefined {
    return this.list().filter((h) => h.policyId === policyId && !TERMINAL.has(h.status)).pop();
  }

  /**
   * Pre-settlement gate for a claim whose verdict says "pay".
   *
   * - Feeds without a quorum policy are not under consensus governance and
   *   pass straight through (legacy single-source behaviour, unchanged).
   * - An existing hold is respected; re-scans never create a second hold.
   * - Any failure here blocks payout (fail closed). The next scan retries.
   */
  gate(candidate: HoldCandidate): GateResult {
    try {
      const existing = this.activeHoldFor(candidate.policyId);
      if (existing) {
        if (existing.status === "released" || existing.status === "approved") {
          return { action: "proceed", holdId: existing.holdId };
        }
        return { action: "block", holdId: existing.holdId, reason: `claim is ${existing.status}: ${existing.reason}` };
      }
      const denied = this.list().filter((h) => h.policyId === candidate.policyId && h.status === "denied").pop();
      if (denied) {
        return { action: "block", holdId: denied.holdId, reason: `payout denied by operator ${denied.disposition?.actor}` };
      }

      if (!this.consensus.isGoverned(candidate.feedId)) return { action: "proceed" };

      const decision = this.consensus.decide(candidate.feedId);
      if (decision.outcome !== "decision") {
        return { action: "block", reason: `consensus produced no decision (${decision.reason})` };
      }
      if (!decision.triggered) {
        return { action: "block", reason: `consensus decision ${decision.decisionId} is not triggered` };
      }

      const gaps = this.assess(decision);
      if (gaps.length === 0) return { action: "proceed" };

      const hold = this.place(candidate, decision, gaps);
      return { action: "block", holdId: hold.holdId, reason: `claim is ${hold.status}: ${hold.reason}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Hold gate failed for policy ${candidate.policyId}; blocking payout: ${msg}`);
      return { action: "block", reason: `hold gate unavailable (${msg})` };
    }
  }

  /**
   * Re-evaluates every `payout_held` claim. Each hold is handled
   * independently, so one failing hold can't stall the others or the
   * policy scan. Re-running without new evidence writes nothing.
   */
  reevaluateAll(): { released: number; escalated: number; stillHeld: number } {
    const summary = { released: 0, escalated: 0, stillHeld: 0 };
    const freshByFeed = new Map<string, DecisionEvent>();
    for (const hold of this.list("payout_held")) {
      try {
        const outcome = this.reevaluate(hold, freshByFeed);
        summary[outcome]++;
      } catch (err) {
        summary.stillHeld++;
        this.logger.error(`Re-evaluation failed for hold ${hold.holdId}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return summary;
  }

  private reevaluate(hold: ClaimHold, freshByFeed: Map<string, DecisionEvent>): "released" | "escalated" | "stillHeld" {
    const now = this.ledger.now();

    if (now > hold.policyExpiresAt) {
      this.escalate(hold, "policy_expired_while_held", "policy expired while the claim was held; trigger predates expiry");
      return "escalated";
    }
    if (now >= hold.deadline) {
      this.escalate(hold, "deadline_exceeded", `evidence still incomplete at deadline: ${describeGaps(hold.gaps)}`);
      return "escalated";
    }

    // Evidence that closes on the original decision (late payload, late
    // signature) releases against that decision, if the verdict still stands.
    let fresh = freshByFeed.get(hold.feedId);
    if (!fresh) {
      fresh = this.consensus.decide(hold.feedId);
      freshByFeed.set(hold.feedId, fresh);
    }
    if (fresh.outcome === "decision" && !fresh.triggered) {
      this.escalate(hold, "verdict_contradicted", `newer evidence contradicts the verdict: ${fresh.reason} (${fresh.decisionId})`);
      return "escalated";
    }

    const candidates: DecisionEvent[] = [];
    if (fresh.outcome === "decision") candidates.push(fresh);
    const original = decisionById(this.ledger.events(), hold.decisionId);
    if (original) candidates.push(original);

    let bestGaps: EvidenceGap[] | null = null;
    let bestDecision = hold.currentDecisionId;
    for (const d of candidates) {
      const gaps = this.assess(d);
      if (gaps.length === 0) {
        this.release(hold, d);
        return "released";
      }
      if (bestGaps === null || gaps.length < bestGaps.length) {
        bestGaps = gaps;
        bestDecision = d.decisionId;
      }
    }

    const gaps = bestGaps ?? hold.gaps;
    if (JSON.stringify(gaps) !== JSON.stringify(hold.gaps)) {
      this.ledger.append({ kind: "hold_reevaluated", holdId: hold.holdId, decisionId: bestDecision, gaps });
    }
    return "stillHeld";
  }

  /** Operator disposition for a held or escalated claim. */
  dispose(holdId: string, disposition: HoldDisposition, actor: string, note: string, extendMs?: number): ClaimHold {
    if (!actor?.trim() || !note?.trim()) throw new BadRequestException("actor and note are required");
    const hold = this.get(holdId);
    if (hold.status !== "escalated" && hold.status !== "payout_held") {
      throw new ConflictException(`hold ${holdId} is ${hold.status}; only held or escalated claims can be disposed`);
    }
    let deadline: number | undefined;
    if (disposition === "extend_hold") {
      if (!(extendMs && extendMs > 0)) throw new BadRequestException("extend_hold requires extendMs > 0");
      deadline = this.ledger.now() + extendMs;
    }
    this.ledger.append({ kind: "hold_disposed", holdId, disposition, actor, note, deadline });
    this.audit(`claim_hold.${disposition}`, actor, note, { holdId, policyId: hold.policyId, deadline });
    return this.get(holdId);
  }

  /** Called once settlement of a released/approved hold confirms. */
  markSettled(holdId: string): void {
    const hold = this.get(holdId);
    if (hold.status === "settled") return;
    this.ledger.append({ kind: "hold_settled", holdId });
    this.audit("claim_hold.settled", "system", "settlement confirmed", { holdId, policyId: hold.policyId });
  }

  private assess(decision: DecisionEvent): EvidenceGap[] {
    return assessEvidenceCompleteness(this.ledger.events(), decision, this.ledger.now(), (h) => this.payloads.has(h));
  }

  private place(candidate: HoldCandidate, decision: DecisionEvent, gaps: EvidenceGap[]): ClaimHold {
    const holdId = `hold_${sha256Hex(`${candidate.policyId}:${decision.decisionId}`).slice(0, 20)}`;
    const reason = describeGaps(gaps);
    this.ledger.append({
      kind: "hold_placed",
      holdId,
      policyId: candidate.policyId,
      holder: candidate.holder,
      feedId: candidate.feedId,
      decisionId: decision.decisionId,
      gaps,
      reason,
      deadline: this.ledger.now() + this.config.holdMaxDurationMs,
      policyExpiresAt: candidate.policyExpiresAt,
    });
    this.audit("claim_hold.placed", "system", reason, { holdId, policyId: candidate.policyId, decisionId: decision.decisionId, gaps });
    this.logger.warn(`Payout held: policy=${candidate.policyId} hold=${holdId} — ${reason}`);
    return this.get(holdId);
  }

  private release(hold: ClaimHold, decision: DecisionEvent): void {
    const reason = `evidence complete and verdict stands (${decision.decisionId}: ${decision.reason})`;
    this.ledger.append({ kind: "hold_released", holdId: hold.holdId, decisionId: decision.decisionId, reason });
    this.audit("claim_hold.released", "system", reason, { holdId: hold.holdId, policyId: hold.policyId, decisionId: decision.decisionId });
    this.logger.log(`Hold ${hold.holdId} released for policy ${hold.policyId}`);
  }

  private escalate(hold: ClaimHold, escalation: HoldEscalationReason, reason: string): void {
    this.ledger.append({ kind: "hold_escalated", holdId: hold.holdId, escalation, reason });
    this.audit("claim_hold.escalated", "system", reason, { holdId: hold.holdId, policyId: hold.policyId, escalation });
    this.logger.warn(`Hold ${hold.holdId} escalated to operator queue (${escalation}): ${reason}`);
  }

  private audit(action: string, actor: string, reason: string, details: Record<string, unknown>): void {
    this.ledger.append({ kind: "audit", action, actor, reason, details });
  }
}
