/**
 * Runs `worker` over `items` with at most `concurrency` in-flight promises.
 * Preserves input order in the result array. Rejections are captured per-item
 * (Promise.allSettled semantics) so one failure never aborts siblings.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        const value = await worker(items[index], index);
        results[index] = { status: "fulfilled", value };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
  await Promise.all(runners);
  return results;
}

/**
 * Serializes async work through a single lane — used so settlement
 * submissions from one relayer account never collide on sequence numbers
 * even while oracle fetches run in parallel.
 */
export class SerialQueue {
  private chain: Promise<unknown> = Promise.resolve();

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    // Swallow rejections on the chain so a failed job doesn't break later ones.
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}
