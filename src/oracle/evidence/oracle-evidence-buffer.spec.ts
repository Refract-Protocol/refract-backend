import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { OracleReading } from "../oracle-reading";
import { EvidenceEntry, EvidenceNotDurableError, EvidenceRecord, EvidenceStore } from "./evidence-record";
import { EvidenceSpool } from "./evidence-spool";
import { OracleEvidenceBuffer } from "./oracle-evidence-buffer";

class FakeStore implements EvidenceStore {
  stored: EvidenceRecord[] = [];
  down = false;
  calls = 0;
  async persist(records: EvidenceRecord[]): Promise<void> {
    this.calls++;
    if (this.down) throw new Error("ECONNREFUSED");
    for (const r of records) if (!this.stored.some((s) => s.seq === r.seq)) this.stored.push(r);
  }
}

const entry = (value: number): EvidenceEntry => ({
  kind: "reading",
  coverageType: "StablecoinDepeg",
  value,
  severity: "low",
  source: "coingecko",
  recordedAt: Date.now(),
  payload: { value },
});

const opts = { batchSize: 2, baseBackoffMs: 5, maxBackoffMs: 20, compactEveryBatches: 2 };
const waitFor = async (cond: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("OracleEvidenceBuffer", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "evbuf-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function started(store: EvidenceStore, maxBytes = 1_000_000) {
    const buffer = new OracleEvidenceBuffer(new EvidenceSpool(dir, maxBytes), store, opts);
    await buffer.start();
    return buffer;
  }

  it("assigns increasing seqs and stores records in order", async () => {
    const store = new FakeStore();
    const buffer = await started(store);
    expect(await buffer.append([entry(1), entry(2), entry(3)])).toEqual([1, 2, 3]);
    expect(await buffer.append([entry(4)])).toEqual([4]);
    await waitFor(() => store.stored.length === 4);
    expect(store.stored.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(buffer.status()).toMatchObject({ pending: 0, lastStoredSeq: 4, storeHealthy: true, complete: true });
    await buffer.stop(100);
  });

  it("keeps accepting evidence while Postgres is down, then drains in order with no loss", async () => {
    const store = new FakeStore();
    store.down = true;
    const buffer = await started(store);

    for (let i = 1; i <= 5; i++) await buffer.append([entry(i)]);
    await waitFor(() => store.calls >= 2);
    expect(buffer.status()).toMatchObject({ pending: 5, storeHealthy: false, complete: true });
    expect(buffer.status().lastStoreError).toContain("ECONNREFUSED");

    store.down = false;
    await waitFor(() => store.stored.length === 5);
    expect(store.stored.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(buffer.status()).toMatchObject({ pending: 0, storeHealthy: true });
    await buffer.stop(100);
  });

  it("replays un-flushed records after a restart without reusing seqs", async () => {
    const store = new FakeStore();
    store.down = true;
    const first = await started(store);
    await first.append([entry(1), entry(2), entry(3)]);
    await first.stop(10);

    store.down = false;
    const second = await started(store);
    await waitFor(() => store.stored.length === 3);
    expect(await second.append([entry(4)])).toEqual([4]);
    await waitFor(() => store.stored.length === 4);
    expect(store.stored.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    await second.stop(100);
  });

  it("fails closed and records an explicit gap when the local spool cannot accept writes", async () => {
    const store = new FakeStore();
    const buffer = await started(store, 600);
    await buffer.append([entry(1)]);

    const big = Array.from({ length: 10 }, (_, i) => entry(100 + i));
    await expect(buffer.append(big)).rejects.toBeInstanceOf(EvidenceNotDurableError);
    expect(buffer.status()).toMatchObject({ complete: false, lostTotal: 10 });
    expect(buffer.status().openGap).toMatchObject({ firstSeq: 2, lastSeq: 11, lostCount: 10 });

    // Once the spool drains and has room, the next append writes the gap marker first.
    await waitFor(() => store.stored.length === 1);
    const [seq] = await buffer.append([entry(2)]);
    expect(seq).toBe(13);
    expect(buffer.status().complete).toBe(true);
    await waitFor(() => store.stored.length === 3);
    expect(store.stored[1]).toMatchObject({ kind: "gap", seq: 12, firstSeq: 2, lastSeq: 11, lostCount: 10 });
    await buffer.stop(100);
  });

  it("recordReadings never throws on the polling path", async () => {
    const buffer = await started(new FakeStore(), 10);
    const reading: OracleReading = {
      coverageType: "StablecoinDepeg",
      type: "oracle_update",
      value: 1,
      threshold: 0.95,
      severity: "low",
      message: "m",
    };
    await expect(buffer.recordReadings([reading])).resolves.toBeUndefined();
    expect(buffer.status().complete).toBe(false);
    await buffer.stop(10);
  });

  it("rejects unknown coverage types before consuming a seq", async () => {
    const buffer = await started(new FakeStore());
    await expect(buffer.append([{ ...entry(1), coverageType: "Nope" }])).rejects.toThrow(/Unknown coverageType/);
    expect(await buffer.append([entry(1)])).toEqual([1]);
    await buffer.stop(100);
  });

  it("rejects appends before start", async () => {
    const buffer = new OracleEvidenceBuffer(new EvidenceSpool(dir, 1000), new FakeStore(), opts);
    await expect(buffer.append([entry(1)])).rejects.toBeInstanceOf(EvidenceNotDurableError);
  });
});
