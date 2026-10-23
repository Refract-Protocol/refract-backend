/** Kinds of oracle pipeline work that must finish before shutdown. */
export type InFlightKind = "poll" | "publish" | "evidence";

export interface DrainResult {
  drained: boolean;
  elapsedMs: number;
  /** Work still running when the deadline passed, by kind. */
  pending: Partial<Record<InFlightKind, number>>;
  /** Ids of the abandoned work (e.g. feed name, tx hash), for reconciliation. */
  abandoned: Array<{ kind: InFlightKind; id?: string; runningMs: number }>;
}

interface Entry {
  kind: InFlightKind;
  id?: string;
  startedAt: number;
  promise: Promise<unknown>;
}

/**
 * Tracks in-flight work so shutdown can wait for it with a deadline.
 *
 * Work started while a drain is running (for example the evidence write a
 * running poll does at the end) is still tracked and waited for. Gating
 * new polls is the caller's job (see OraclePipelineLifecycle).
 */
export class InFlightTracker {
  private readonly entries = new Set<Entry>();

  track<T>(kind: InFlightKind, work: () => Promise<T>, id?: string): Promise<T> {
    let promise: Promise<T>;
    try {
      promise = work();
    } catch (err) {
      promise = Promise.reject(err);
    }
    const entry: Entry = { kind, id, startedAt: Date.now(), promise };
    this.entries.add(entry);
    const done = () => this.entries.delete(entry);
    promise.then(done, done);
    return promise;
  }

  count(kind?: InFlightKind): number {
    if (!kind) return this.entries.size;
    let n = 0;
    for (const e of this.entries) if (e.kind === kind) n++;
    return n;
  }

  /** Waits until nothing is in flight, or until `deadlineMs` passes. Never throws. */
  async drain(deadlineMs: number, now: () => number = Date.now): Promise<DrainResult> {
    const start = now();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, deadlineMs));
    });
    try {
      // Loop because work can start while we wait (poll → publish → evidence).
      while (this.entries.size > 0) {
        const pending = [...this.entries].map((e) => e.promise.then(
          () => undefined,
          () => undefined,
        ));
        const winner = await Promise.race([Promise.all(pending), deadline]);
        if (winner === "timeout") break;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    const pending: DrainResult["pending"] = {};
    const abandoned: DrainResult["abandoned"] = [];
    const end = Date.now();
    for (const e of this.entries) {
      pending[e.kind] = (pending[e.kind] ?? 0) + 1;
      abandoned.push({ kind: e.kind, id: e.id, runningMs: end - e.startedAt });
    }
    return { drained: this.entries.size === 0, elapsedMs: now() - start, pending, abandoned };
  }
}
