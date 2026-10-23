import { createHash } from "crypto";
import { Injectable, Logger } from "@nestjs/common";
import { OracleReading, Severity } from "../oracle-reading";
import { ConsensusWindowRepository, ConsensusDecisionRow, WindowReadingRow } from "./consensus-window.repository";
import { FeedWindowConfig, getFeedConfig } from "./window-config";
import {
  computeWindowBounds,
  isArrivedTooLate,
  isLateArrival,
  isWindowClosed,
} from "./window-id";

export interface IngestResult {
  windowId: string;
  status: "accepted" | "late_accepted" | "late_dropped" | "too_late" | "duplicate";
  isLate: boolean;
}

export interface ConsensusResult {
  windowId: string;
  feedId: string;
  value: number;
  severity: Severity;
  readingCount: number;
  lateReadingCount: number;
  inputHash: string;
  /** True when this window had zero eligible readings. */
  empty: boolean;
  decision: ConsensusDecisionRow | null;
}

/**
 * Core windowing service.
 *
 * Responsibilities:
 *  - Assign each incoming reading to its deterministic window bucket.
 *  - Apply late-arrival and duplicate-suppression policies.
 *  - Evaluate closed windows to produce a consensus decision.
 *  - Produce a replay-safe inputHash so a re-run of the same window yields
 *    byte-identical output.
 */
@Injectable()
export class ConsensusWindowService {
  private readonly logger = new Logger(ConsensusWindowService.name);

  constructor(
    private readonly repo: ConsensusWindowRepository,
    private readonly configs: FeedWindowConfig[] = [],
  ) {}

  // ── Reading ingest ─────────────────────────────────────────────────────────

  /**
   * Ingests a single oracle reading.
   *
   * 1. Computes the deterministic window bucket for the reading's source timestamp.
   * 2. Applies late-arrival and watermark logic.
   * 3. Suppresses duplicates (same source already in the window).
   * 4. Persists to consensus_window_readings.
   */
  async ingest(
    reading: OracleReading & { source: string; sourceTimestamp?: Date },
    arrivalTime: Date = new Date(),
  ): Promise<IngestResult> {
    const config = getFeedConfig(reading.coverageType, this.configs);
    const sourceTs = reading.sourceTimestamp ?? arrivalTime;
    const { windowId, windowStart, windowEnd } = computeWindowBounds(
      reading.coverageType,
      sourceTs,
      config.windowDurationMs,
    );

    // Ensure the window row exists.
    await this.repo.upsertWindow({
      feedId: reading.coverageType,
      windowId,
      windowStart,
      windowEnd,
    });

    const windowAlreadyClosed = isWindowClosed(windowEnd, arrivalTime);
    const tooLate = isArrivedTooLate(arrivalTime, windowEnd, config.allowedLatenessMs);
    const late = windowAlreadyClosed && isLateArrival(arrivalTime, windowEnd);

    // Reading arrived after the watermark — always discard silently (not stored).
    if (tooLate) {
      this.logger.debug(
        `[${reading.coverageType}] reading from ${reading.source ?? "unknown"} arrived too late for window ${windowId} — discarding`,
      );
      return { windowId, status: "too_late", isLate: true };
    }

    // Late reading: apply per-feed policy.
    const isDropped = late && config.lateArrivalPolicy === "drop";

    const inserted = await this.repo.insertReading({
      windowId,
      feedId: reading.coverageType,
      source: reading.source ?? this.extractSource(reading.message),
      value: reading.value,
      severity: reading.severity,
      sourceTimestamp: sourceTs,
      arrivalTimestamp: arrivalTime,
      isLate: late,
      isDropped,
    });

    if (inserted === null) {
      return { windowId, status: "duplicate", isLate: late };
    }

    if (late && isDropped) {
      return { windowId, status: "late_dropped", isLate: true };
    }
    if (late) {
      return { windowId, status: "late_accepted", isLate: true };
    }
    return { windowId, status: "accepted", isLate: false };
  }

  // ── Consensus evaluation ───────────────────────────────────────────────────

  /**
   * Evaluates a closed window and records a consensus decision.
   *
   * - Only processes closed windows unless bestEffort is true.
   * - An empty window (zero eligible readings) is recorded with value=0,
   *   severity="low", and readingCount=0 so evidence ledger entries exist.
   * - The inputHash is SHA-256 over sorted reading IDs for replay verification.
   */
  async evaluateWindow(windowId: string): Promise<ConsensusResult> {
    const window = await this.repo.getWindow(windowId);
    if (!window) throw new Error(`Window ${windowId} not found`);

    const config = getFeedConfig(window.feedId, this.configs);
    const closed = isWindowClosed(window.windowEnd, new Date());

    if (!closed && !config.bestEffort) {
      throw new Error(
        `Window ${windowId} is not yet closed — consensus can only be evaluated on closed windows`,
      );
    }

    const readings = await this.repo.getEligibleReadings(windowId);
    const lateReadings = readings.filter((r) => r.isLate);

    const inputHash = this.computeInputHash(readings);

    if (readings.length === 0) {
      this.logger.warn(`[${window.feedId}] window ${windowId} closed with zero eligible readings`);
      const decision = await this.repo.recordDecision({
        feedId: window.feedId,
        windowId,
        windowStart: window.windowStart,
        windowEnd: window.windowEnd,
        readingCount: 0,
        lateReadingCount: 0,
        value: 0,
        severity: "low",
        inputHash,
      });
      await this.repo.markEvaluated(windowId);
      return {
        windowId,
        feedId: window.feedId,
        value: 0,
        severity: "low",
        readingCount: 0,
        lateReadingCount: 0,
        inputHash,
        empty: true,
        decision,
      };
    }

    const { value, severity } = this.computeMedianConsensus(readings);

    const decision = await this.repo.recordDecision({
      feedId: window.feedId,
      windowId,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      readingCount: readings.length,
      lateReadingCount: lateReadings.length,
      value,
      severity,
      inputHash,
    });

    await this.repo.markEvaluated(windowId);

    return {
      windowId,
      feedId: window.feedId,
      value,
      severity,
      readingCount: readings.length,
      lateReadingCount: lateReadings.length,
      inputHash,
      empty: false,
      decision,
    };
  }

  /**
   * Closes any windows that have passed their end time and returns their IDs
   * so the caller can trigger evaluation.
   */
  async closeExpiredWindows(feedId: string): Promise<string[]> {
    const windows = await this.repo.getClosedUnevaluatedWindows(feedId);
    // Also check open windows in memory by looking at the scheduler tick.
    // Actual closing is driven by the repository query — windows whose
    // window_end < now() are candidates; we close them here.
    // (The upsert-on-ingest path only creates the row; closing is separate.)
    return windows.map((w) => w.windowId);
  }

  // ── Replay ────────────────────────────────────────────────────────────────

  /**
   * Re-evaluates a window from its persisted readings and returns the result.
   * The inputHash must match the original to confirm byte-identical replay.
   */
  async replayWindow(windowId: string): Promise<ConsensusResult & { hashMatch: boolean }> {
    const prior = await this.repo.getDecision(windowId);
    const result = await this.evaluateWindow(windowId);
    return {
      ...result,
      hashMatch: prior !== null && prior.inputHash === result.inputHash,
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Consensus = median value across eligible readings.
   * Sorted by source (deterministic order) before computing median.
   */
  private computeMedianConsensus(readings: WindowReadingRow[]): { value: number; severity: Severity } {
    const sorted = [...readings].sort((a, b) => a.value - b.value);
    const mid = Math.floor(sorted.length / 2);
    const value =
      sorted.length % 2 === 0
        ? (sorted[mid - 1].value + sorted[mid].value) / 2
        : sorted[mid].value;

    // Severity: majority vote (first-in-alphabetical-order breaks ties).
    const counts = new Map<string, number>();
    for (const r of readings) counts.set(r.severity, (counts.get(r.severity) ?? 0) + 1);
    const severity = [...counts.entries()].sort((a, b) =>
      b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0]),
    )[0][0] as Severity;

    return { value, severity };
  }

  /**
   * Computes a deterministic SHA-256 hash of the sorted reading IDs.
   * Same readings in any order → same hash. Used for replay verification.
   */
  private computeInputHash(readings: WindowReadingRow[]): string {
    const sorted = [...readings].map((r) => r.id).sort();
    return createHash("sha256").update(sorted.join(",")).digest("hex");
  }

  private extractSource(message: string): string {
    const match = /\[([^\]]+)\]/.exec(message);
    if (!match) return "unknown";
    return match[1].split(";")[0].trim().substring(0, 40);
  }
}
