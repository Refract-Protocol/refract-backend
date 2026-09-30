import { mapWithConcurrency, SerialQueue } from "./concurrency.util";

describe("mapWithConcurrency", () => {
  it("limits in-flight workers to the configured concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);

    await mapWithConcurrency(items, 3, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight--;
      return n * 2;
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("preserves order and captures per-item rejections", async () => {
    const items = [1, 2, 3];
    const results = await mapWithConcurrency(items, 2, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });

    expect(results[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(results[1]).toEqual({ status: "rejected", reason: expect.any(Error) });
    expect(results[2]).toEqual({ status: "fulfilled", value: 3 });
  });
});

describe("SerialQueue", () => {
  it("runs enqueued tasks one at a time in order", async () => {
    const queue = new SerialQueue();
    const order: number[] = [];

    const p1 = queue.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push(1);
    });
    const p2 = queue.enqueue(async () => {
      order.push(2);
    });
    const p3 = queue.enqueue(async () => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("continues after a rejected task", async () => {
    const queue = new SerialQueue();
    const order: string[] = [];

    await queue.enqueue(async () => {
      order.push("a");
      throw new Error("fail");
    }).catch(() => undefined);

    await queue.enqueue(async () => {
      order.push("b");
    });

    expect(order).toEqual(["a", "b"]);
  });
});
