import { Logger } from "@nestjs/common";
import { promises as fs } from "fs";
import * as path from "path";
import { EvidenceRecord } from "./evidence-record";

const SPOOL_FILE = "spool.ndjson";
const ACK_FILE = "acked-seq";

export class SpoolFullError extends Error {
  constructor(bytes: number, max: number) {
    super(`evidence spool is full (${bytes} of ${max} bytes)`);
    this.name = "SpoolFullError";
  }
}

export interface SpoolRecovery {
  pending: EvidenceRecord[];
  /** Highest seq ever seen on disk (acked or pending). */
  highWaterSeq: number;
  /** Lines that could not be parsed (torn final write or corruption). */
  discardedLines: number;
}

/**
 * Append-only, fsync'd local write-ahead log for oracle evidence.
 *
 * Records are appended as NDJSON and fsync'd before `append` resolves, so a
 * resolved append survives a process crash. Records the flusher has stored
 * in Postgres are tracked by an "acked" high-water mark; the file is
 * compacted once everything is acked. Acking is written before compaction,
 * and Postgres inserts are idempotent per seq, so a crash at any point can
 * only cause a harmless re-insert, never a loss.
 *
 * All file operations are serialized on one promise chain.
 */
export class EvidenceSpool {
  private readonly logger = new Logger(EvidenceSpool.name);
  private readonly spoolPath: string;
  private readonly ackPath: string;
  private handle: fs.FileHandle | null = null;
  private bytes = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly maxBytes: number,
  ) {
    this.spoolPath = path.join(dir, SPOOL_FILE);
    this.ackPath = path.join(dir, ACK_FILE);
  }

  /** Opens the spool and returns un-acked records in seq order. */
  open(): Promise<SpoolRecovery> {
    return this.serial(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const acked = await this.readAcked();
      const text = await fs.readFile(this.spoolPath, "utf8").catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return "";
        throw err;
      });

      const pending: EvidenceRecord[] = [];
      let highWaterSeq = acked;
      let discardedLines = 0;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as EvidenceRecord;
          if (typeof record.seq !== "number") throw new Error("missing seq");
          highWaterSeq = Math.max(highWaterSeq, record.seq);
          if (record.seq > acked) pending.push(record);
        } catch {
          discardedLines++;
        }
      }
      pending.sort((a, b) => a.seq - b.seq);

      // Rewrite the file if it holds acked records or a torn/corrupt line, so
      // new appends always start on a clean line boundary.
      const needsRewrite = discardedLines > 0 || pending.length !== countLines(text) || (text.length > 0 && !text.endsWith("\n"));
      if (needsRewrite) {
        await this.rewrite(pending);
      }
      if (discardedLines > 0) {
        this.logger.error(`Discarded ${discardedLines} unreadable evidence spool line(s) during recovery`);
      }

      this.handle = await fs.open(this.spoolPath, "a");
      this.bytes = (await this.handle.stat()).size;
      return { pending, highWaterSeq, discardedLines };
    });
  }

  /** Appends records and fsyncs. Rejects with SpoolFullError when the size cap would be exceeded. */
  append(records: EvidenceRecord[]): Promise<void> {
    return this.serial(async () => {
      if (!this.handle) throw new Error("evidence spool is not open");
      const data = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
      const size = Buffer.byteLength(data);
      if (this.bytes + size > this.maxBytes) {
        throw new SpoolFullError(this.bytes, this.maxBytes);
      }
      await this.handle.write(data);
      await this.handle.datasync();
      this.bytes += size;
    });
  }

  /**
   * Marks everything up to `seq` as stored. With `compact`, the file is
   * rewritten to hold only records after `seq`. The rewrite reads the file
   * itself inside the serial chain, so appends queued before it are never
   * lost.
   */
  ack(seq: number, compact: boolean): Promise<void> {
    return this.serial(async () => {
      await writeFileDurable(this.ackPath, String(seq));
      if (!compact) return;
      await this.handle?.close();
      const text = await fs.readFile(this.spoolPath, "utf8");
      const remaining = text
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as EvidenceRecord)
        .filter((record) => record.seq > seq);
      await this.rewrite(remaining);
      this.handle = await fs.open(this.spoolPath, "a");
      this.bytes = (await this.handle.stat()).size;
    });
  }

  sizeBytes(): number {
    return this.bytes;
  }

  close(): Promise<void> {
    return this.serial(async () => {
      await this.handle?.close();
      this.handle = null;
    });
  }

  private async readAcked(): Promise<number> {
    try {
      const n = Number((await fs.readFile(this.ackPath, "utf8")).trim());
      return Number.isInteger(n) && n >= 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  private async rewrite(records: EvidenceRecord[]): Promise<void> {
    const data = records.length ? records.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
    await writeFileDurable(this.spoolPath, data);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
}

function countLines(text: string): number {
  return text.split("\n").filter((l) => l.trim()).length;
}

/** Write to a temp file, fsync, then atomically rename over the target. */
async function writeFileDurable(target: string, data: string): Promise<void> {
  const tmp = `${target}.tmp`;
  const handle = await fs.open(tmp, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, target);
}
