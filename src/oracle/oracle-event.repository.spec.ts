import type { DbService } from "../db/db.service";
import { EvidenceRecord } from "./evidence/evidence-record";
import { OracleEventRepository } from "./oracle-event.repository";

// The real DbService pulls in app config; the repository only needs withClient().
jest.mock("../db/db.service", () => ({ DbService: class DbService {} }));

function fakeDb(failOn?: RegExp) {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  const client = {
    query: jest.fn(async (text: string, params?: unknown[]) => {
      queries.push({ text, params });
      if (failOn && failOn.test(text)) throw new Error("db down");
      return { rows: [] };
    }),
  };
  const db = { withClient: async (fn: (c: typeof client) => Promise<unknown>) => fn(client) } as unknown as DbService;
  return { db, queries };
}

const reading: EvidenceRecord = {
  seq: 7,
  kind: "reading",
  coverageType: "MarketCrash",
  value: -31.5,
  severity: "triggered",
  source: "coingecko",
  recordedAt: 1_700_000_000_000,
  payload: { a: 1 },
};

describe("OracleEventRepository", () => {
  it("writes readings and gaps idempotently by seq inside one transaction", async () => {
    const { db, queries } = fakeDb();
    await new OracleEventRepository(db).persist([
      reading,
      { seq: 8, kind: "gap", firstSeq: 5, lastSeq: 6, lostCount: 2, openedAt: 1, closedAt: 2, reason: "disk full", recordedAt: 2 },
    ]);
    expect(queries.map((q) => q.text.trim().split(/\s+/)[0])).toEqual(["BEGIN", "INSERT", "INSERT", "COMMIT"]);
    expect(queries[1].text).toContain("ON CONFLICT (seq, recorded_at) DO NOTHING");
    expect(queries[1].params).toEqual([7, "reading", "market_crash", -31.5, "coingecko", "triggered", '{"a":1}', 1_700_000_000_000]);
    expect(queries[2].text).toContain("oracle_evidence_gaps");
  });

  it("rolls back and rethrows so the buffer retries the batch", async () => {
    const { db, queries } = fakeDb(/INSERT/);
    await expect(new OracleEventRepository(db).persist([reading])).rejects.toThrow("db down");
    expect(queries.map((q) => q.text.trim())).toContain("ROLLBACK");
  });

  it("refuses records with an unknown coverage type instead of skipping them", async () => {
    const { db } = fakeDb();
    await expect(new OracleEventRepository(db).persist([{ ...reading, coverageType: "X" } as EvidenceRecord])).rejects.toThrow(
      /unknown coverageType/,
    );
  });
});
