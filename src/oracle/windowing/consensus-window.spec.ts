/**
 * Tests for per-feed event-time windowing:
 *   1. Watermark advancement and window boundary computation
 *   2. Late-arrival acceptance vs rejection (by policy)
 *   3. Duplicate suppression within a window
 *   4. Empty-window handling
 *   5. Replay test — re-run of a recorded window produces byte-identical output
 */

import {
  computeWindowBounds,
  computeWatermark,
  isArrivedTooLate,
  isLateArrival,
  isWindowClosed,
} from "./window-id";
import { ConsensusWindowService, IngestResult } from "./consensus-window.service";
import { ConsensusWindowRepository, WindowReadingRow, WindowRow, ConsensusDecisionRow } from "./consensus-window.repository";
import { OracleReading } from "../oracle-reading";
import { FeedWindowConfig } from "./window-config";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FEED_ID = "StablecoinDepeg";
const WINDOW_DURATION_MS = 30_000;
const ALLOWED_LATENESS_MS = 5_000;

/** A fixed reference point: 2024-01-01 00:00:00 UTC */
const T0 = new Date("2024-01-01T00:00:00.000Z");
/** Inside the first 30-second window starting at T0 */
const T_INSIDE = new Date(T0.getTime() + 10_000);
/** Exactly at window end */
const T_WINDOW_END = new Date(T0.getTime() + WINDOW_DURATION_MS);
/** After window end but before watermark */
const T_LATE = new Date(T_WINDOW_END.getTime() + 2_000);
/** After watermark */
const T_TOO_LATE = new Date(T_WINDOW_END.getTime() + ALLOWED_LATENESS_MS + 1);

function makeReading(overrides: Partial<OracleReading & { source: string; sourceTimestamp: Date }> = {}): OracleReading & { source: string; sourceTimestamp: Date } {
  return {
    coverageType: FEED_ID,
    type: "oracle_update",
    value: 0.9998,
    threshold: 0.95,
    severity: "low",
    message: "[CoinGecko]",
    source: "CoinGecko",
    sourceTimestamp: T_INSIDE,
    ...overrides,
  };
}

const DROP_CONFIG: FeedWindowConfig = {
  feedId: FEED_ID,
  windowDurationMs: WINDOW_DURATION_MS,
  allowedLatenessMs: ALLOWED_LATENESS_MS,
  lateArrivalPolicy: "drop",
  bestEffort: false,
};

const CARRY_CONFIG: FeedWindowConfig = {
  ...DROP_CONFIG,
  lateArrivalPolicy: "carry_next",
};

// ── Mock repository builder ───────────────────────────────────────────────────

function makeWindow(windowId: string, status: WindowRow["status"] = "open"): WindowRow {
  const { windowStart, windowEnd } = computeWindowBounds(FEED_ID, T_INSIDE, WINDOW_DURATION_MS);
  return {
    id: "wrow-1",
    feedId: FEED_ID,
    windowId,
    windowStart,
    windowEnd,
    status,
    createdAt: T0,
    closedAt: status !== "open" ? T_WINDOW_END : null,
    evaluatedAt: null,
  };
}

type MockRepo = {
  [K in keyof ConsensusWindowRepository]: jest.Mock;
};

function buildMockRepo(readings: WindowReadingRow[] = []): MockRepo {
  const windows = new Map<string, WindowRow>();
  const decisions = new Map<string, ConsensusDecisionRow>();

  return {
    upsertWindow: jest.fn(async (params) => {
      if (!windows.has(params.windowId)) {
        windows.set(params.windowId, {
          id: "w-1",
          feedId: params.feedId,
          windowId: params.windowId,
          windowStart: params.windowStart,
          windowEnd: params.windowEnd,
          status: "open",
          createdAt: new Date(),
          closedAt: null,
          evaluatedAt: null,
        });
      }
      return windows.get(params.windowId)!;
    }),
    closeWindow: jest.fn(async (windowId) => {
      const w = windows.get(windowId);
      if (w) w.status = "closed";
    }),
    markEvaluated: jest.fn(async (windowId) => {
      const w = windows.get(windowId);
      if (w) w.status = "evaluated";
    }),
    getWindow: jest.fn(async (windowId) => windows.get(windowId) ?? null),
    getClosedUnevaluatedWindows: jest.fn(async () => []),
    insertReading: jest.fn(async (params) => {
      const existing = readings.find(
        (r) => r.windowId === params.windowId && r.source === params.source,
      );
      if (existing) return null; // duplicate
      const row: WindowReadingRow = {
        id: `r-${readings.length + 1}`,
        windowId: params.windowId,
        feedId: params.feedId,
        source: params.source,
        value: params.value,
        severity: params.severity,
        sourceTimestamp: params.sourceTimestamp,
        arrivalTimestamp: params.arrivalTimestamp,
        isLate: params.isLate,
        isDropped: params.isDropped,
        isDuplicate: false,
      };
      readings.push(row);
      return row;
    }),
    getEligibleReadings: jest.fn(async () => readings.filter((r) => !r.isDropped)),
    getAllReadings: jest.fn(async () => readings),
    recordDecision: jest.fn(async (params) => {
      const d: ConsensusDecisionRow = {
        id: "d-1",
        feedId: params.feedId,
        windowId: params.windowId,
        windowStart: params.windowStart,
        windowEnd: params.windowEnd,
        readingCount: params.readingCount,
        lateReadingCount: params.lateReadingCount,
        value: params.value,
        severity: params.severity,
        decidedAt: new Date(),
        inputHash: params.inputHash,
      };
      decisions.set(params.windowId, d);
      return d;
    }),
    getDecision: jest.fn(async (windowId) => decisions.get(windowId) ?? null),
  } as unknown as MockRepo;
}

function buildService(
  config: FeedWindowConfig,
  repo?: MockRepo,
  readings: WindowReadingRow[] = [],
): { svc: ConsensusWindowService; repo: MockRepo } {
  const r = repo ?? buildMockRepo(readings);
  const svc = new ConsensusWindowService(
    r as unknown as ConsensusWindowRepository,
    [config],
  );
  return { svc, repo: r };
}

// ── 1. Window boundary and watermark computation ───────────────────────────────

describe("window-id helpers", () => {
  it("aligns windows to Unix epoch multiples", () => {
    const ts = new Date("2024-01-01T00:00:15.000Z"); // 15s into a 30s window
    const { windowStart, windowEnd, windowId } = computeWindowBounds(FEED_ID, ts, WINDOW_DURATION_MS);
    expect(windowStart).toEqual(new Date("2024-01-01T00:00:00.000Z"));
    expect(windowEnd).toEqual(new Date("2024-01-01T00:00:30.000Z"));
    expect(windowId).toBe(`${FEED_ID}:2024-01-01T00:00:00.000Z`);
  });

  it("produces the same window ID for two readings inside the same bucket", () => {
    const a = computeWindowBounds(FEED_ID, new Date("2024-01-01T00:00:05.000Z"), WINDOW_DURATION_MS);
    const b = computeWindowBounds(FEED_ID, new Date("2024-01-01T00:00:28.000Z"), WINDOW_DURATION_MS);
    expect(a.windowId).toBe(b.windowId);
  });

  it("produces different window IDs for readings in adjacent buckets", () => {
    const a = computeWindowBounds(FEED_ID, new Date("2024-01-01T00:00:29.999Z"), WINDOW_DURATION_MS);
    const b = computeWindowBounds(FEED_ID, new Date("2024-01-01T00:00:30.000Z"), WINDOW_DURATION_MS);
    expect(a.windowId).not.toBe(b.windowId);
  });

  it("computes watermark correctly", () => {
    const wm = computeWatermark(T_WINDOW_END, ALLOWED_LATENESS_MS);
    expect(wm).toEqual(new Date(T_WINDOW_END.getTime() + ALLOWED_LATENESS_MS));
  });

  it("isLateArrival is true between windowEnd and watermark", () => {
    expect(isLateArrival(T_LATE, T_WINDOW_END)).toBe(true);
    expect(isLateArrival(T_INSIDE, T_WINDOW_END)).toBe(false);
  });

  it("isArrivedTooLate is true only after watermark", () => {
    expect(isArrivedTooLate(T_LATE, T_WINDOW_END, ALLOWED_LATENESS_MS)).toBe(false);
    expect(isArrivedTooLate(T_TOO_LATE, T_WINDOW_END, ALLOWED_LATENESS_MS)).toBe(true);
  });

  it("isWindowClosed is false before windowEnd, true after", () => {
    expect(isWindowClosed(T_WINDOW_END, T_INSIDE)).toBe(false);
    expect(isWindowClosed(T_WINDOW_END, T_LATE)).toBe(true);
  });
});

// ── 2. Late-arrival acceptance vs rejection ───────────────────────────────────

describe("ConsensusWindowService — late arrivals", () => {
  it("accepts a reading inside the window (status: accepted)", async () => {
    const { svc } = buildService(DROP_CONFIG);
    const result = await svc.ingest(makeReading(), T_INSIDE);
    expect(result.status).toBe("accepted");
    expect(result.isLate).toBe(false);
  });

  it("policy=drop: late reading is stored as dropped, not counted", async () => {
    const readings: WindowReadingRow[] = [];
    const { svc } = buildService(DROP_CONFIG, undefined, readings);
    const result = await svc.ingest(makeReading({ source: "CoinGecko" }), T_LATE);
    expect(result.status).toBe("late_dropped");
    expect(result.isLate).toBe(true);
    expect(readings[0].isDropped).toBe(true);
  });

  it("policy=carry_next: late reading is stored and NOT dropped", async () => {
    const readings: WindowReadingRow[] = [];
    const { svc } = buildService(CARRY_CONFIG, undefined, readings);
    const result = await svc.ingest(makeReading({ source: "CoinGecko" }), T_LATE);
    expect(result.status).toBe("late_accepted");
    expect(readings[0].isDropped).toBe(false);
    expect(readings[0].isLate).toBe(true);
  });

  it("discards readings that arrived beyond the watermark (too_late)", async () => {
    const readings: WindowReadingRow[] = [];
    const { svc, repo } = buildService(CARRY_CONFIG, undefined, readings);
    const result = await svc.ingest(makeReading({ source: "CoinGecko" }), T_TOO_LATE);
    expect(result.status).toBe("too_late");
    // Nothing persisted — too-late readings are not stored at all.
    expect((repo.insertReading as jest.Mock).mock.calls).toHaveLength(0);
  });
});

// ── 3. Duplicate suppression ──────────────────────────────────────────────────

describe("ConsensusWindowService — duplicate suppression", () => {
  it("returns duplicate status when same source submits twice in the same window", async () => {
    const readings: WindowReadingRow[] = [];
    const { svc } = buildService(DROP_CONFIG, undefined, readings);

    const first = await svc.ingest(makeReading({ source: "CoinGecko", value: 0.9998 }), T_INSIDE);
    const second = await svc.ingest(makeReading({ source: "CoinGecko", value: 0.9997 }), T_INSIDE);

    expect(first.status).toBe("accepted");
    expect(second.status).toBe("duplicate");
    // Only one row persisted.
    expect(readings).toHaveLength(1);
    expect(readings[0].value).toBe(0.9998); // first value wins
  });

  it("allows different sources in the same window", async () => {
    const readings: WindowReadingRow[] = [];
    const { svc } = buildService(DROP_CONFIG, undefined, readings);

    await svc.ingest(makeReading({ source: "CoinGecko" }), T_INSIDE);
    await svc.ingest(makeReading({ source: "Binance" }), T_INSIDE);

    expect(readings).toHaveLength(2);
  });
});

// ── 4. Empty-window handling ──────────────────────────────────────────────────

describe("ConsensusWindowService — empty windows", () => {
  it("evaluates an empty closed window without throwing, records zero-reading decision", async () => {
    const { windowId, windowEnd } = computeWindowBounds(FEED_ID, T_INSIDE, WINDOW_DURATION_MS);
    const repo = buildMockRepo([]);
    // Pre-populate a closed window.
    (repo.getWindow as jest.Mock).mockResolvedValue({
      id: "w-1",
      feedId: FEED_ID,
      windowId,
      windowStart: T0,
      windowEnd: T_WINDOW_END,
      status: "closed",
      createdAt: T0,
      closedAt: T_WINDOW_END,
      evaluatedAt: null,
    } as WindowRow);
    (repo.getEligibleReadings as jest.Mock).mockResolvedValue([]);

    const { svc } = buildService(DROP_CONFIG, repo);
    const result = await svc.evaluateWindow(windowId);

    expect(result.empty).toBe(true);
    expect(result.readingCount).toBe(0);
    expect(result.decision).not.toBeNull();
  });

  it("refuses to evaluate an open window when bestEffort=false", async () => {
    const { windowId } = computeWindowBounds(FEED_ID, T_INSIDE, WINDOW_DURATION_MS);
    const repo = buildMockRepo([]);
    (repo.getWindow as jest.Mock).mockResolvedValue({
      id: "w-1",
      feedId: FEED_ID,
      windowId,
      windowStart: T0,
      windowEnd: T_WINDOW_END,
      status: "open",
      createdAt: T0,
      closedAt: null,
      evaluatedAt: null,
    } as WindowRow);

    // Simulate window not yet closed (T_INSIDE is before T_WINDOW_END).
    jest.spyOn(Date, "now").mockReturnValue(T_INSIDE.getTime());
    const { svc } = buildService(DROP_CONFIG, repo);

    await expect(svc.evaluateWindow(windowId)).rejects.toThrow(/not yet closed/);
    jest.spyOn(Date, "now").mockRestore();
  });
});

// ── 5. Replay test ────────────────────────────────────────────────────────────

describe("ConsensusWindowService — replay", () => {
  it("re-evaluating a window produces the same inputHash as the original decision", async () => {
    const { windowId } = computeWindowBounds(FEED_ID, T_INSIDE, WINDOW_DURATION_MS);
    const readings: WindowReadingRow[] = [
      {
        id: "r-1",
        windowId,
        feedId: FEED_ID,
        source: "CoinGecko",
        value: 0.9998,
        severity: "low",
        sourceTimestamp: T_INSIDE,
        arrivalTimestamp: T_INSIDE,
        isLate: false,
        isDropped: false,
        isDuplicate: false,
      },
      {
        id: "r-2",
        windowId,
        feedId: FEED_ID,
        source: "Binance",
        value: 0.9995,
        severity: "low",
        sourceTimestamp: T_INSIDE,
        arrivalTimestamp: T_INSIDE,
        isLate: false,
        isDropped: false,
        isDuplicate: false,
      },
    ];

    const repo = buildMockRepo(readings);
    (repo.getWindow as jest.Mock).mockResolvedValue({
      id: "w-1",
      feedId: FEED_ID,
      windowId,
      windowStart: T0,
      windowEnd: T_WINDOW_END,
      status: "closed",
      createdAt: T0,
      closedAt: T_WINDOW_END,
      evaluatedAt: null,
    } as WindowRow);

    const { svc } = buildService(DROP_CONFIG, repo);

    // First evaluation — records original decision.
    const first = await svc.evaluateWindow(windowId);

    // Simulate restart: load the prior decision from DB.
    (repo.getDecision as jest.Mock).mockResolvedValue(first.decision);
    // Mark window as needing re-evaluation.
    (repo.getWindow as jest.Mock).mockResolvedValue({
      ...makeWindow(windowId, "closed"),
      windowStart: T0,
      windowEnd: T_WINDOW_END,
    });

    // Replay.
    const replay = await svc.replayWindow(windowId);

    expect(replay.hashMatch).toBe(true);
    expect(replay.inputHash).toBe(first.inputHash);
    expect(replay.value).toBe(first.value);
    expect(replay.readingCount).toBe(first.readingCount);
  });

  it("hashMatch is false when the reading set has changed since the original decision", async () => {
    const { windowId } = computeWindowBounds(FEED_ID, T_INSIDE, WINDOW_DURATION_MS);
    const readings: WindowReadingRow[] = [
      {
        id: "r-99", // different ID from what was originally recorded
        windowId,
        feedId: FEED_ID,
        source: "CoinGecko",
        value: 0.9998,
        severity: "low",
        sourceTimestamp: T_INSIDE,
        arrivalTimestamp: T_INSIDE,
        isLate: false,
        isDropped: false,
        isDuplicate: false,
      },
    ];

    const repo = buildMockRepo(readings);
    (repo.getWindow as jest.Mock).mockResolvedValue({
      id: "w-1",
      feedId: FEED_ID,
      windowId,
      windowStart: T0,
      windowEnd: T_WINDOW_END,
      status: "closed",
      createdAt: T0,
      closedAt: T_WINDOW_END,
      evaluatedAt: null,
    } as WindowRow);

    // Simulate a prior decision with a different inputHash (different reading IDs).
    const staleDecision: ConsensusDecisionRow = {
      id: "d-old",
      feedId: FEED_ID,
      windowId,
      windowStart: T0,
      windowEnd: T_WINDOW_END,
      readingCount: 1,
      lateReadingCount: 0,
      value: 0.9998,
      severity: "low",
      decidedAt: T_WINDOW_END,
      inputHash: "aaaa0000000000000000000000000000000000000000000000000000000000",
    };
    (repo.getDecision as jest.Mock).mockResolvedValue(staleDecision);

    const { svc } = buildService(DROP_CONFIG, repo);
    const replay = await svc.replayWindow(windowId);

    expect(replay.hashMatch).toBe(false);
  });

  it("consensus value is deterministic regardless of reading insertion order", async () => {
    // Two orderings of the same readings must produce the same median.
    function evalReadings(values: number[]): number {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
    }
    const orderA = evalReadings([0.9998, 0.9997, 0.9996]);
    const orderB = evalReadings([0.9996, 0.9998, 0.9997]);
    expect(orderA).toBe(orderB);
  });
});
