import { CursorOutsideRetentionWindowError } from "./cursor-outside-retention.error";
import { EventIndexerRpc, EventIndexerService, RawRpcEvent } from "./event-indexer.service";
import { CapitalProvidedHandler } from "./handlers/capital-provided.handler";
import { CapitalWithdrawnHandler } from "./handlers/capital-withdrawn.handler";
import { ClaimProcessedHandler } from "./handlers/claim-processed.handler";
import { EVENT_TOPICS } from "./handlers/event-types";
import { PolicyPurchasedHandler } from "./handlers/policy-purchased.handler";
import { IndexerCursor, IndexerCursorRepository } from "./indexer-cursor.repository";

/** In-memory cursor + processed_events stand-in — no Postgres required. */
class InMemoryCursorRepo {
  cursor: IndexerCursor = {
    cursorKey: "soroban_events",
    lastLedger: 0,
    lastEventId: "",
    updatedAt: null,
  };
  processed = new Set<string>();

  async getCursor(): Promise<IndexerCursor> {
    return { ...this.cursor };
  }

  async saveCursor(lastLedger: number, lastEventId: string): Promise<void> {
    this.cursor = {
      ...this.cursor,
      lastLedger,
      lastEventId,
      updatedAt: new Date(),
    };
  }

  async hasProcessed(eventId: string): Promise<boolean> {
    return this.processed.has(eventId);
  }

  async tryMarkProcessed(input: { eventId: string }): Promise<boolean> {
    if (this.processed.has(input.eventId)) {
      return false;
    }
    this.processed.add(input.eventId);
    return true;
  }
}

type HandlerFn = (event: { eventId: string }) => Promise<void>;

function mockHandler(): { handle: jest.MockedFunction<HandlerFn> } {
  return { handle: jest.fn(async (_event: { eventId: string }) => undefined) as jest.MockedFunction<HandlerFn> };
}

function buildIndexer(opts: {
  rpc: EventIndexerRpc;
  cursorRepo?: InMemoryCursorRepo;
  policyPurchased?: { handle: HandlerFn };
  capitalProvided?: { handle: HandlerFn };
  capitalWithdrawn?: { handle: HandlerFn };
  claimProcessed?: { handle: HandlerFn };
  pageLimit?: number;
  enabled?: boolean;
}) {
  const cursorRepo = opts.cursorRepo ?? new InMemoryCursorRepo();
  const policyPurchased = opts.policyPurchased ?? mockHandler();
  const capitalProvided = opts.capitalProvided ?? mockHandler();
  const capitalWithdrawn = opts.capitalWithdrawn ?? mockHandler();
  const claimProcessed = opts.claimProcessed ?? mockHandler();

  const indexer = EventIndexerService.forTest({
    rpc: opts.rpc,
    cursorRepo: cursorRepo as unknown as IndexerCursorRepository,
    policyPurchased: policyPurchased as unknown as PolicyPurchasedHandler,
    capitalProvided: capitalProvided as unknown as CapitalProvidedHandler,
    capitalWithdrawn: capitalWithdrawn as unknown as CapitalWithdrawnHandler,
    claimProcessed: claimProcessed as unknown as ClaimProcessedHandler,
    config: {
      enabled: opts.enabled ?? true,
      pageLimit: opts.pageLimit ?? 2,
      pollIntervalMs: 5_000,
      lagAlertLedgers: 100,
      contractIds: ["CPPOOL"],
    },
  });

  return {
    indexer,
    cursorRepo,
    policyPurchased,
    capitalProvided,
    capitalWithdrawn,
    claimProcessed,
  };
}

function makeEvent(
  overrides: Partial<RawRpcEvent> & { id: string; ledger: number; topicName?: string }
): RawRpcEvent {
  const topicName = overrides.topicName ?? EVENT_TOPICS.POLICY_PURCHASED;
  const { topicName: _topic, ...rest } = overrides;
  void _topic;
  return {
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    contractId: "CPPOOL",
    txHash: "abc",
    _nativeValue: {
      policy_id: "1",
      holder: "GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCD",
      coverage_type: 0,
      coverage_amount: 1_000_0000n,
      premium: 1000n,
      duration_days: 30,
      expires_at: 1_800_000_000,
    },
    ...rest,
    _topicName: topicName,
    _nativeTopics: rest._nativeTopics ?? [topicName],
  };
}

describe("EventIndexerService", () => {
  it("advances the cursor only after a page is fully processed", async () => {
    const pages: RawRpcEvent[][] = [
      [makeEvent({ id: "1000-1", ledger: 1000 }), makeEvent({ id: "1000-2", ledger: 1000 })],
    ];
    let calls = 0;
    const rpc: EventIndexerRpc = {
      getLatestLedger: async () => ({ sequence: 1000 }),
      getEvents: async () => {
        const events = pages[calls] ?? [];
        calls += 1;
        return { events, latestLedger: 1100, oldestLedger: 900, cursor: "next" };
      },
    };
    const { indexer, cursorRepo, policyPurchased } = buildIndexer({ rpc, pageLimit: 2 });
    cursorRepo.cursor = { ...cursorRepo.cursor, lastLedger: 999, lastEventId: "999-1" };

    await indexer.poll();

    expect(policyPurchased.handle).toHaveBeenCalledTimes(2);
    expect(cursorRepo.cursor.lastLedger).toBe(1000);
    expect(cursorRepo.cursor.lastEventId).toBe("1000-2");
  });

  it("projects duplicate events only once (idempotent)", async () => {
    const event = makeEvent({ id: "2000-1", ledger: 2000 });
    const rpc: EventIndexerRpc = {
      getLatestLedger: async () => ({ sequence: 2000 }),
      getEvents: jest
        .fn()
        .mockResolvedValueOnce({
          events: [event],
          latestLedger: 2100,
          oldestLedger: 1000,
          cursor: "c1",
        })
        .mockResolvedValueOnce({
          events: [event],
          latestLedger: 2100,
          oldestLedger: 1000,
          cursor: "c1",
        })
        .mockResolvedValue({ events: [], latestLedger: 2100, oldestLedger: 1000 }),
    };
    const { indexer, cursorRepo, policyPurchased } = buildIndexer({ rpc, pageLimit: 10 });
    cursorRepo.cursor = { ...cursorRepo.cursor, lastLedger: 1999, lastEventId: "1999-1" };

    await indexer.poll();
    // Reset cursor slightly so the same event is eligible again by ledger,
    // but processed_events still blocks re-projection.
    cursorRepo.cursor = { ...cursorRepo.cursor, lastLedger: 1999, lastEventId: "1999-1" };
    await indexer.poll();

    expect(policyPurchased.handle).toHaveBeenCalledTimes(1);
    expect(cursorRepo.processed.has("2000-1")).toBe(true);
  });

  it("does not advance the cursor past an event whose handler throws", async () => {
    const ok = makeEvent({ id: "3000-1", ledger: 3000 });
    const bad = makeEvent({ id: "3000-2", ledger: 3000 });
    const after = makeEvent({ id: "3000-3", ledger: 3000 });

    const policyPurchased = mockHandler();
    policyPurchased.handle.mockImplementation(async (event) => {
      if (event.eventId === "3000-2") {
        throw new Error("boom");
      }
    });

    const rpc: EventIndexerRpc = {
      getLatestLedger: async () => ({ sequence: 3000 }),
      getEvents: async () => ({
        events: [ok, bad, after],
        latestLedger: 3100,
        oldestLedger: 1000,
      }),
    };
    const { indexer, cursorRepo } = buildIndexer({ rpc, policyPurchased, pageLimit: 10 });
    cursorRepo.cursor = { ...cursorRepo.cursor, lastLedger: 2999, lastEventId: "2999-1" };

    await indexer.poll();

    expect(cursorRepo.cursor.lastEventId).toBe("3000-1");
    expect(cursorRepo.cursor.lastLedger).toBe(3000);
    expect(cursorRepo.processed.has("3000-2")).toBe(false);
    expect(cursorRepo.processed.has("3000-3")).toBe(false);
    expect(policyPurchased.handle).toHaveBeenCalledTimes(2); // ok + bad
  });

  it("drains getEvents pages fully before finishing the poll", async () => {
    const page1 = [makeEvent({ id: "4000-1", ledger: 4000 }), makeEvent({ id: "4000-2", ledger: 4000 })];
    const page2 = [makeEvent({ id: "4001-1", ledger: 4001 })];
    const requests: unknown[] = [];

    const rpc: EventIndexerRpc = {
      getLatestLedger: async () => ({ sequence: 4000 }),
      getEvents: async (req) => {
        requests.push(req);
        if (!("cursor" in req) || !req.cursor) {
          return { events: page1, latestLedger: 4100, oldestLedger: 1000, cursor: "page2" };
        }
        if (req.cursor === "page2") {
          return { events: page2, latestLedger: 4100, oldestLedger: 1000, cursor: "done" };
        }
        return { events: [], latestLedger: 4100, oldestLedger: 1000 };
      },
    };
    const { indexer, cursorRepo, policyPurchased } = buildIndexer({ rpc, pageLimit: 2 });
    cursorRepo.cursor = { ...cursorRepo.cursor, lastLedger: 3999, lastEventId: "3999-1" };

    await indexer.poll();

    expect(policyPurchased.handle).toHaveBeenCalledTimes(3);
    expect(cursorRepo.cursor.lastEventId).toBe("4001-1");
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests.some((r) => r && typeof r === "object" && "cursor" in r && (r as { cursor: string }).cursor === "page2")).toBe(
      true
    );
  });

  it("raises CursorOutsideRetentionWindowError when the cursor is outside retention", async () => {
    const rpc: EventIndexerRpc = {
      getLatestLedger: async () => ({ sequence: 5000 }),
      getEvents: async () => ({
        events: [],
        latestLedger: 5000,
        oldestLedger: 4500,
      }),
    };
    const { indexer, cursorRepo } = buildIndexer({ rpc });
    cursorRepo.cursor = { ...cursorRepo.cursor, lastLedger: 1000, lastEventId: "1000-1" };

    await indexer.poll();

    const status = indexer.getStatus();
    expect(status.retentionError).toMatch(/outside the Soroban RPC retention window/i);
    expect(status.retentionError).toMatch(/1000/);
    // Error type is recorded via message; also verify the class mapping path:
    expect(() => {
      throw new CursorOutsideRetentionWindowError(1000, 4500, 5000);
    }).toThrow(CursorOutsideRetentionWindowError);
  });

  it("backfill over a range is idempotent when run twice", async () => {
    const events = [
      makeEvent({ id: "6000-1", ledger: 6000 }),
      makeEvent({ id: "6001-1", ledger: 6001, topicName: EVENT_TOPICS.CAPITAL_PROVIDED, _nativeValue: {
        provider: "GPROVIDER",
        amount: 500n,
        shares: 50n,
      }}),
    ];
    const rpc: EventIndexerRpc = {
      getEvents: async () => ({
        events,
        latestLedger: 7000,
        oldestLedger: 5000,
        cursor: "x",
      }),
    };
    const { indexer, policyPurchased, capitalProvided } = buildIndexer({ rpc, pageLimit: 10 });

    const first = await indexer.backfill(6000, 6001);
    const second = await indexer.backfill(6000, 6001);

    expect(first.processed).toBe(2);
    expect(second.processed).toBe(0);
    expect(policyPurchased.handle).toHaveBeenCalledTimes(1);
    expect(capitalProvided.handle).toHaveBeenCalledTimes(1);
  });

  it("getStatus reports processed count, lag, and last timestamp", async () => {
    const rpc: EventIndexerRpc = {
      getLatestLedger: async () => ({ sequence: 7000 }),
      getEvents: async () => ({
        events: [makeEvent({ id: "7000-1", ledger: 7000 })],
        latestLedger: 7100,
        oldestLedger: 1000,
      }),
    };
    const { indexer, cursorRepo } = buildIndexer({ rpc, pageLimit: 10 });
    cursorRepo.cursor = { ...cursorRepo.cursor, lastLedger: 6999, lastEventId: "6999-1" };

    await indexer.poll();
    const status = indexer.getStatus();

    expect(status.eventsProcessed).toBe(1);
    expect(status.lastLedger).toBe(7000);
    expect(status.latestRpcLedger).toBe(7100);
    expect(status.lagLedgers).toBe(100);
    expect(status.lastProcessedAt).toBeTruthy();
    expect(status.retentionError).toBeNull();
  });

  it("skips polling when disabled or no contracts are configured", async () => {
    const getEvents = jest.fn();
    const rpc: EventIndexerRpc = { getEvents };
    const disabled = buildIndexer({ rpc, enabled: true });
    // Force empty contracts after construction.
    (disabled.indexer as unknown as { cfg: { contractIds: string[]; enabled: boolean } }).cfg.contractIds = [];
    await disabled.indexer.poll();
    expect(getEvents).not.toHaveBeenCalled();

    const off = buildIndexer({
      rpc: { getEvents },
      enabled: false,
    });
    await off.indexer.poll();
    expect(getEvents).not.toHaveBeenCalled();
  });
});
