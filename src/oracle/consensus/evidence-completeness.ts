import { DecisionEvent, EvidenceEvent, EvidenceGap } from "./evidence.types";
import { policyAt, readingById, sourcesAt } from "./ledger-view";

/**
 * Evidence-completeness precheck, run before a triggered decision is paid.
 *
 * Pure over (ledger events, decision, now, payload availability): it returns
 * a structured, ordered list of gaps, and an empty list means the evidence
 * behind the decision is complete. It never decides *whether* to pay; it
 * only says whether the evidence is complete enough to act on.
 *
 * - `insufficient_sources`: fewer independent contributing sources than the
 *   policy's `expectedSources` (a source dropped out mid-window, or two
 *   contributors are suspected mirrors of each other).
 * - `source_in_warmup`: a contributor was still warming up at decision time.
 * - `missing_raw_payload`: a contributor's raw payload was never captured,
 *   or its body is not in the payload store.
 * - `signature_pending`: a contributor's signature was not yet verified as
 *   of `now` (a later `signature_result` closes this gap).
 */
export function assessEvidenceCompleteness(
  events: readonly EvidenceEvent[],
  decision: DecisionEvent,
  now: number,
  payloadAvailable: (hash: string) => boolean,
): EvidenceGap[] {
  const gaps: EvidenceGap[] = [];
  const policy = policyAt(events, decision.feedId, decision.at);
  const expected = policy?.expectedSources ?? 0;

  // Suspected mirrors (issue #273) are not independent corroboration.
  const independent = decision.contributing.filter((c) => c.independent !== false).length;
  if (independent < expected) {
    const mirrored = decision.contributing.length - independent;
    gaps.push({
      type: "insufficient_sources",
      detail:
        `${independent} independent source(s) contributed${mirrored ? ` (+${mirrored} suspected mirror)` : ""}; ` +
        `policy v${policy?.version} expects ${expected}`,
    });
  }

  const sourcesAtDecision = new Map(sourcesAt(events, decision.feedId, decision.at).map((s) => [s.sourceId, s]));
  const contributors = [...decision.contributing].sort((a, b) => a.readingId.localeCompare(b.readingId));

  for (const c of contributors) {
    if (sourcesAtDecision.get(c.sourceId)?.status === "warmup") {
      gaps.push({
        type: "source_in_warmup",
        detail: `source ${c.sourceId} was in warm-up when the decision was made`,
        sourceId: c.sourceId,
        readingId: c.readingId,
      });
    }
  }

  for (const c of contributors) {
    const reading = readingById(events, c.readingId, now);
    if (!reading || reading.payloadHash === null || !payloadAvailable(reading.payloadHash)) {
      gaps.push({
        type: "missing_raw_payload",
        detail: `raw payload for reading ${c.readingId} (source ${c.sourceId}) is not in the evidence store`,
        sourceId: c.sourceId,
        readingId: c.readingId,
      });
    }
    if (reading?.signature === "pending") {
      gaps.push({
        type: "signature_pending",
        detail: `signature for reading ${c.readingId} (source ${c.sourceId}) is still pending verification`,
        sourceId: c.sourceId,
        readingId: c.readingId,
      });
    }
  }

  return gaps;
}

export function describeGaps(gaps: EvidenceGap[]): string {
  if (gaps.length === 0) return "evidence complete";
  const types = [...new Set(gaps.map((g) => g.type))].join(", ");
  return `held for incomplete evidence (${types}): ${gaps.map((g) => g.detail).join("; ")}`;
}
