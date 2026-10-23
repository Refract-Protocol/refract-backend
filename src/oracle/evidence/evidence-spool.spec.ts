import { mkdtempSync, promises as fs, rmSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { SequencedEvidence } from "./evidence-record";
import { EvidenceSpool, SpoolFullError } from "./evidence-spool";

function rec(seq: number): SequencedEvidence {
  return { seq, kind: "reading", coverageType: "StablecoinDepeg", value: 1, severity: "low", source: "s", recordedAt: seq, payload: {} };
}

describe("EvidenceSpool", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "spool-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("persists appends across reopen and reports the high-water seq", async () => {
    const a = new EvidenceSpool(dir, 1_000_000);
    await a.open();
    await a.append([rec(1), rec(2)]);
    await a.append([rec(3)]);
    await a.close();

    const b = new EvidenceSpool(dir, 1_000_000);
    const recovery = await b.open();
    expect(recovery.pending.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(recovery.highWaterSeq).toBe(3);
    await b.close();
  });

  it("skips acked records on recovery and keeps the seq high-water mark after truncation", async () => {
    const a = new EvidenceSpool(dir, 1_000_000);
    await a.open();
    await a.append([rec(1), rec(2), rec(3)]);
    await a.ack(2, false);
    await a.close();

    const b = new EvidenceSpool(dir, 1_000_000);
    expect((await b.open()).pending.map((r) => r.seq)).toEqual([3]);
    await b.ack(3, true);
    await b.close();

    expect(await fs.readFile(path.join(dir, "spool.ndjson"), "utf8")).toBe("");
    const c = new EvidenceSpool(dir, 1_000_000);
    const recovery = await c.open();
    expect(recovery.pending).toEqual([]);
    expect(recovery.highWaterSeq).toBe(3);
    await c.close();
  });

  it("drops a torn final line and leaves the file clean for new appends", async () => {
    await fs.writeFile(path.join(dir, "spool.ndjson"), JSON.stringify(rec(1)) + "\n" + '{"seq":2,"kind":"rea');
    const s = new EvidenceSpool(dir, 1_000_000);
    const recovery = await s.open();
    expect(recovery.pending.map((r) => r.seq)).toEqual([1]);
    expect(recovery.discardedLines).toBe(1);
    await s.append([rec(2)]);
    await s.close();

    const reopened = new EvidenceSpool(dir, 1_000_000);
    const again = await reopened.open();
    expect(again.pending.map((r) => r.seq)).toEqual([1, 2]);
    expect(again.discardedLines).toBe(0);
    await reopened.close();
  });

  it("compaction keeps records appended after the acked seq", async () => {
    const s = new EvidenceSpool(dir, 1_000_000);
    await s.open();
    await s.append([rec(1), rec(2)]);
    const appendLater = s.append([rec(3)]);
    await Promise.all([s.ack(2, true), appendLater]);
    await s.close();
    const reopened = new EvidenceSpool(dir, 1_000_000);
    expect((await reopened.open()).pending.map((r) => r.seq)).toEqual([3]);
    await reopened.close();
  });

  it("rejects appends beyond the size cap without writing", async () => {
    const s = new EvidenceSpool(dir, 200);
    await s.open();
    await expect(s.append([rec(1), rec(2), rec(3)])).rejects.toBeInstanceOf(SpoolFullError);
    expect(s.sizeBytes()).toBe(0);
    await s.close();
  });
});
