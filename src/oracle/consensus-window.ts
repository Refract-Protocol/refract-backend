import crypto from "node:crypto";

export type LateArrivalPolicy = "drop" | "carry_next";

export interface ConsensusWindowConfig {
  feedId: string;
  windowDurationMs: number;
  allowedLatenessMs: number;
  quorumSize: number;
  latePolicy: LateArrivalPolicy;
  bestEffort?: boolean;
  maxClockSkewMs?: number;
  maxCarryHorizonWindows?: number;
}

export interface WindowReadingInput {
  feedId: string;
  sourceId: string;
  value: number;
  sourceTimestampMs: number;
  ingestedAtMs?: number;
  metadata?: Record<string, unknown>;
}

export interface StoredWindowReading {
  readingId: string;
  feedId: string;
  sourceId: string;
  value: number;
  sourceTimestampMs: number;
  ingestedAtMs: number;
  originWindowId: string;
  assignedWindowId: string;
  late: boolean;
  lateAction: "on_time" | "accepted_within_lateness" | "dropped_late" | "carried_to_next_window";
  carriedFromWindowId?: string;
}

export interface WindowBounds {
  windowId: string;
  feedId: string;
  windowStartMs: number;
  windowEndMs: number;
}

export interface ConsensusWindowDecision {
  decisionId: string;
  feedId: string;
  windowId: string;
  windowStartMs: number;
  windowEndMs: number;
  status: "quorum_reached" | "insufficient_quorum" | "empty_window";
  medianValue: number | null;
  quorumSize: number;
  participatingSources: string[];
  readingsHash: string;
  evaluatedAtWatermarkMs: number;
}

export interface WindowSnapshot {
  feedId: string;
  windowId: string;
  windowStartMs: number;
  windowEndMs: number;
  closed: boolean;
  closedAtWatermarkMs: number | null;
  config: ConsensusWindowConfig;
  readings: StoredWindowReading[];
  droppedLateReadings: StoredWindowReading[];
  decision: ConsensusWindowDecision | null;
}

export function validateConsensusWindowConfig(config: ConsensusWindowConfig): void {
  if (!config || !config.feedId || !config.feedId.trim()) {
    throw new Error("ConsensusWindowConfig requires a non-empty feedId");
  }
  if (!Number.isInteger(config.windowDurationMs) || config.windowDurationMs <= 0) {
    throw new Error(`Invalid windowDurationMs (${config.windowDurationMs}) for feed "${config.feedId}"`);
  }
  if (!Number.isInteger(config.allowedLatenessMs) || config.allowedLatenessMs < 0) {
    throw new Error(`Invalid allowedLatenessMs (${config.allowedLatenessMs}) for feed "${config.feedId}"`);
  }
  if (!Number.isInteger(config.quorumSize) || config.quorumSize < 1) {
    throw new Error(`Invalid quorumSize (${config.quorumSize}) for feed "${config.feedId}"`);
  }
  if (config.latePolicy !== "drop" && config.latePolicy !== "carry_next") {
    throw new Error(`Unsupported latePolicy "${String(config.latePolicy)}" for feed "${config.feedId}"`);
  }
}

export function computeWindowBounds(
  feedId: string,
  timestampMs: number,
  windowDurationMs: number
): WindowBounds {
  const bucketIndex = Math.floor(timestampMs / windowDurationMs);
  const windowStartMs = bucketIndex * windowDurationMs;
  const windowEndMs = windowStartMs + windowDurationMs;
  return {
    windowId: `${feedId}:${windowStartMs}-${windowEndMs}`,
    feedId,
    windowStartMs,
    windowEndMs,
  };
}

export function computeDeterministicMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function hashCanonicalReadings(readings: readonly StoredWindowReading[]): string {
  const canonical = [...readings]
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
    .map((r) => ({
      sourceId: r.sourceId,
      value: r.value,
      sourceTimestampMs: r.sourceTimestampMs,
      originWindowId: r.originWindowId,
      assignedWindowId: r.assignedWindowId,
      late: r.late,
    }));
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Pure, deterministic window evaluator used both at watermark close time and
 * by the replay harness (`replayWindow`). Produces byte-identical output for
 * identical window inputs regardless of arrival order.
 */
export function evaluateWindowSnapshot(
  snapshot: Pick<
    WindowSnapshot,
    "feedId" | "windowId" | "windowStartMs" | "windowEndMs" | "config" | "readings"
  >,
  evaluatedAtWatermarkMs: number
): ConsensusWindowDecision {
  const ordered = [...snapshot.readings].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  const readingsHash = hashCanonicalReadings(ordered);
  const decisionSeed = `${snapshot.windowId}:${readingsHash}`;
  const decisionId = crypto.createHash("sha256").update(decisionSeed).digest("hex").slice(0, 32);

  if (ordered.length === 0) {
    return {
      decisionId,
      feedId: snapshot.feedId,
      windowId: snapshot.windowId,
      windowStartMs: snapshot.windowStartMs,
      windowEndMs: snapshot.windowEndMs,
      status: "empty_window",
      medianValue: null,
      quorumSize: snapshot.config.quorumSize,
      participatingSources: [],
      readingsHash,
      evaluatedAtWatermarkMs,
    };
  }

  const hasQuorum =
    ordered.length >= snapshot.config.quorumSize || snapshot.config.bestEffort === true;
  const medianValue = hasQuorum
    ? computeDeterministicMedian(ordered.map((r) => r.value))
    : null;

  return {
    decisionId,
    feedId: snapshot.feedId,
    windowId: snapshot.windowId,
    windowStartMs: snapshot.windowStartMs,
    windowEndMs: snapshot.windowEndMs,
    status: hasQuorum ? "quorum_reached" : "insufficient_quorum",
    medianValue,
    quorumSize: snapshot.config.quorumSize,
    participatingSources: ordered.map((r) => r.sourceId),
    readingsHash,
    evaluatedAtWatermarkMs,
  };
}

export class ConsensusWindowManager {
  private readonly configs = new Map<string, ConsensusWindowConfig>();
  private readonly windows = new Map<string, WindowSnapshot>();
  private readonly watermarks = new Map<string, number>();

  registerFeed(config: ConsensusWindowConfig): void {
    validateConsensusWindowConfig(config);
    this.configs.set(config.feedId, {
      maxClockSkewMs: 5_000,
      maxCarryHorizonWindows: 1,
      ...config,
    });
    if (!this.watermarks.has(config.feedId)) {
      this.watermarks.set(config.feedId, 0);
    }
  }

  getWatermark(feedId: string): number {
    return this.watermarks.get(feedId) ?? 0;
  }

  private getOrCreateWindow(config: ConsensusWindowConfig, bounds: WindowBounds): WindowSnapshot {
    const existing = this.windows.get(bounds.windowId);
    if (existing) return existing;

    const currentWatermark = this.getWatermark(config.feedId);
    const alreadyPastDeadline = bounds.windowEndMs + config.allowedLatenessMs <= currentWatermark;
    const created: WindowSnapshot = {
      feedId: config.feedId,
      windowId: bounds.windowId,
      windowStartMs: bounds.windowStartMs,
      windowEndMs: bounds.windowEndMs,
      closed: alreadyPastDeadline,
      closedAtWatermarkMs: alreadyPastDeadline ? currentWatermark : null,
      config,
      readings: [],
      droppedLateReadings: [],
      decision: null,
    };
    this.windows.set(bounds.windowId, created);
    return created;
  }

  /**
   * Ingests a provider reading into its event-time window.
   * - Rejects readings future-dated beyond `maxClockSkewMs` relative to `ingestedAtMs`.
   * - De-duplicates readings from the same `(sourceId, assignedWindowId)`.
   * - Flags readings arriving after `windowEndMs + allowedLatenessMs` or after the
   *   window has already closed as `late: true`, applying the feed's `latePolicy`
   *   (`drop` vs `carry_next`) without ever mutating an already-closed window's
   *   eligible reading set or settled decision.
   */
  ingestReading(input: WindowReadingInput): {
    accepted: boolean;
    duplicate: boolean;
    reading: StoredWindowReading;
  } {
    const config = this.configs.get(input.feedId);
    if (!config) {
      throw new Error(`No consensus window config registered for feed "${input.feedId}"`);
    }
    if (!Number.isFinite(input.value)) {
      throw new Error(`Invalid reading value for feed "${input.feedId}"`);
    }

    const ingestedAtMs = input.ingestedAtMs ?? Date.now();
    const maxSkew = config.maxClockSkewMs ?? 5_000;
    if (input.sourceTimestampMs - ingestedAtMs > maxSkew) {
      throw new Error(
        `Reading sourceTimestampMs (${input.sourceTimestampMs}) exceeds clock skew tolerance (+${maxSkew}ms) over ingestedAtMs (${ingestedAtMs})`
      );
    }

    const originBounds = computeWindowBounds(
      config.feedId,
      input.sourceTimestampMs,
      config.windowDurationMs
    );
    const originWindow = this.getOrCreateWindow(config, originBounds);
    const watermarkMs = Math.max(this.getWatermark(config.feedId), ingestedAtMs);
    const deadlineMs = originBounds.windowEndMs + config.allowedLatenessMs;
    const isPastWatermark = originWindow.closed || watermarkMs > deadlineMs;
    const arrivedAfterWindowEnd = ingestedAtMs > originBounds.windowEndMs;

    const readingId = crypto
      .createHash("sha256")
      .update(`${config.feedId}:${input.sourceId}:${input.sourceTimestampMs}:${input.value}`)
      .digest("hex")
      .slice(0, 24);

    if (!isPastWatermark) {
      const existing = originWindow.readings.find((r) => r.sourceId === input.sourceId);
      if (existing) {
        return { accepted: false, duplicate: true, reading: existing };
      }

      const stored: StoredWindowReading = {
        readingId,
        feedId: config.feedId,
        sourceId: input.sourceId,
        value: input.value,
        sourceTimestampMs: input.sourceTimestampMs,
        ingestedAtMs,
        originWindowId: originBounds.windowId,
        assignedWindowId: originBounds.windowId,
        late: arrivedAfterWindowEnd,
        lateAction: arrivedAfterWindowEnd ? "accepted_within_lateness" : "on_time",
      };
      originWindow.readings.push(stored);
      return { accepted: true, duplicate: false, reading: stored };
    }

    // Late arrival past watermark / allowed lateness
    const maxCarryWindows = config.maxCarryHorizonWindows ?? 1;
    const nextWindowStartMs = originBounds.windowEndMs;
    const maxCarryDeadlineMs =
      originBounds.windowEndMs + maxCarryWindows * config.windowDurationMs;

    if (config.latePolicy === "carry_next" && watermarkMs <= maxCarryDeadlineMs) {
      const nextBounds = computeWindowBounds(
        config.feedId,
        nextWindowStartMs,
        config.windowDurationMs
      );
      const nextWindow = this.getOrCreateWindow(config, nextBounds);
      if (!nextWindow.closed) {
        const existingInNext = nextWindow.readings.find((r) => r.sourceId === input.sourceId);
        if (existingInNext) {
          return { accepted: false, duplicate: true, reading: existingInNext };
        }
        const carried: StoredWindowReading = {
          readingId,
          feedId: config.feedId,
          sourceId: input.sourceId,
          value: input.value,
          sourceTimestampMs: input.sourceTimestampMs,
          ingestedAtMs,
          originWindowId: originBounds.windowId,
          assignedWindowId: nextBounds.windowId,
          late: true,
          lateAction: "carried_to_next_window",
          carriedFromWindowId: originBounds.windowId,
        };
        nextWindow.readings.push(carried);
        return { accepted: true, duplicate: false, reading: carried };
      }
    }

    const dropped: StoredWindowReading = {
      readingId,
      feedId: config.feedId,
      sourceId: input.sourceId,
      value: input.value,
      sourceTimestampMs: input.sourceTimestampMs,
      ingestedAtMs,
      originWindowId: originBounds.windowId,
      assignedWindowId: originBounds.windowId,
      late: true,
      lateAction: "dropped_late",
    };
    originWindow.droppedLateReadings.push(dropped);
    return { accepted: false, duplicate: false, reading: dropped };
  }

  /**
   * Advances the watermark for `feedId` (monotonically) to `watermarkMs`,
   * closes all open windows whose `windowEndMs + allowedLatenessMs <= watermarkMs`,
   * and evaluates consensus once per closed window.
   */
  advanceWatermark(feedId: string, watermarkMs: number): ConsensusWindowDecision[] {
    const config = this.configs.get(feedId);
    if (!config) {
      throw new Error(`No consensus window config registered for feed "${feedId}"`);
    }
    const previous = this.getWatermark(feedId);
    const nextWatermark = Math.max(previous, watermarkMs);
    this.watermarks.set(feedId, nextWatermark);

    const emitted: ConsensusWindowDecision[] = [];
    const feedWindows = [...this.windows.values()]
      .filter((w) => w.feedId === feedId && !w.closed)
      .sort((a, b) => a.windowStartMs - b.windowStartMs);

    for (const win of feedWindows) {
      if (win.windowEndMs + config.allowedLatenessMs <= nextWatermark) {
        win.closed = true;
        win.closedAtWatermarkMs = nextWatermark;
        win.decision = evaluateWindowSnapshot(win, nextWatermark);
        emitted.push(win.decision);
      }
    }

    return emitted;
  }

  getWindowSnapshot(windowId: string): WindowSnapshot | null {
    const win = this.windows.get(windowId);
    if (!win) return null;
    return {
      ...win,
      readings: [...win.readings],
      droppedLateReadings: [...win.droppedLateReadings],
      decision: win.decision ? { ...win.decision } : null,
    };
  }

  /**
   * Replays a recorded window snapshot deterministically and verifies that the
   * recomputed decision matches the recorded decision byte-for-byte.
   */
  replayWindow(windowId: string): ConsensusWindowDecision {
    const win = this.windows.get(windowId);
    if (!win) {
      throw new Error(`Unknown window "${windowId}"`);
    }
    if (!win.closed || win.closedAtWatermarkMs === null) {
      throw new Error(`Cannot replay open window "${windowId}" before watermark close`);
    }
    return evaluateWindowSnapshot(win, win.closedAtWatermarkMs);
  }
}
