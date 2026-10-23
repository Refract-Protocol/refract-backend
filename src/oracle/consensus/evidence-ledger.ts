import * as fs from "fs";
import * as path from "path";
import { payloadHash } from "./canonical";
import { EvidenceEvent, NewEvidenceEvent } from "./evidence.types";

/**
 * Append-only evidence ledger.
 *
 * Events live in memory and, when `filePath` is set, are also appended as
 * one JSON object per line to that file. The file is the persisted record:
 * it is reloaded on boot and the operator CLI reads the same file, so API
 * and CLI work from identical evidence.
 *
 * There is deliberately no update or delete. Corrections are new events.
 */
export class EvidenceLedger {
  private readonly log: EvidenceEvent[] = [];

  constructor(
    private readonly filePath?: string,
    private readonly clock: () => number = Date.now,
  ) {
    if (filePath && fs.existsSync(filePath)) {
      this.log.push(...EvidenceLedger.parseJsonl(fs.readFileSync(filePath, "utf8")));
    }
  }

  static parseJsonl(text: string): EvidenceEvent[] {
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as EvidenceEvent);
  }

  /** Builds a read-only ledger from already-persisted events (CLI, tests). */
  static fromEvents(events: EvidenceEvent[]): EvidenceLedger {
    const ledger = new EvidenceLedger();
    ledger.log.push(...events);
    return ledger;
  }

  /** Ledger time: the wall clock, but never behind the last recorded event. */
  now(): number {
    return Math.max(this.clock(), this.lastRecordedAt());
  }

  /**
   * Appends an event. Persistence happens before the in-memory push, so if
   * the write fails the event is not observed anywhere and the caller sees
   * the error (callers on the payout path fail closed on that error).
   */
  append<E extends NewEvidenceEvent>(event: E): EvidenceEvent {
    const full = {
      ...event,
      seq: this.log.length + 1,
      recordedAt: Math.max(event.recordedAt ?? this.clock(), this.lastRecordedAt() + 1),
    } as unknown as EvidenceEvent;
    if (this.filePath) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, `${JSON.stringify(full)}\n`);
    }
    this.log.push(full);
    return full;
  }

  /**
   * The timestamp the next append will receive. Timestamps are strictly
   * increasing, so "events recorded at or before T" is an exact prefix of
   * the ledger. A live decision computed at reserveTimestamp() and appended
   * with that recordedAt is therefore exactly reproducible from T alone.
   */
  reserveTimestamp(): number {
    return Math.max(this.clock(), this.lastRecordedAt() + 1);
  }

  private lastRecordedAt(): number {
    return this.log.length ? this.log[this.log.length - 1].recordedAt : Number.NEGATIVE_INFINITY;
  }

  /** Snapshot of all events, oldest first. Callers must not mutate. */
  events(): readonly EvidenceEvent[] {
    return this.log;
  }
}

/**
 * Content-addressed store for raw provider payload bodies. Only the body can
 * be removed (license purge); the hash and every ledger reference to it stay.
 */
export class PayloadStore {
  private readonly bodies = new Map<string, string>();

  constructor(private readonly dir?: string) {
    if (dir) fs.mkdirSync(dir, { recursive: true });
  }

  put(body: string): string {
    const hash = payloadHash(body);
    if (this.dir) {
      fs.writeFileSync(path.join(this.dir, hash), body);
    } else {
      this.bodies.set(hash, body);
    }
    return hash;
  }

  has(hash: string): boolean {
    assertHash(hash);
    return this.dir ? fs.existsSync(path.join(this.dir, hash)) : this.bodies.has(hash);
  }

  get(hash: string): string | undefined {
    assertHash(hash);
    if (this.dir) {
      const file = path.join(this.dir, hash);
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
    }
    return this.bodies.get(hash);
  }

  /** Deletes a body. Idempotent: deleting an absent body is a no-op. */
  delete(hash: string): void {
    assertHash(hash);
    if (this.dir) {
      fs.rmSync(path.join(this.dir, hash), { force: true });
    } else {
      this.bodies.delete(hash);
    }
  }
}

/** Hashes double as file names, so reject anything that is not sha256 hex. */
function assertHash(hash: string): void {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`Invalid payload hash "${hash}"`);
}
