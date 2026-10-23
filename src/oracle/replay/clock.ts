import { Clock, Random } from "./types";

/** Clock that only moves when told to; no wall-time dependence. */
export class ManualClock implements Clock {
  constructor(private current: number) {}

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    if (ms < 0) {
      throw new Error(`ManualClock cannot go backwards (advance ${ms})`);
    }
    this.current += ms;
  }

  setTime(ms: number): void {
    this.current = ms;
  }

  async sleep(ms: number): Promise<void> {
    this.advance(ms);
  }
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** mulberry32: small, fast, fully deterministic PRNG. */
export function seededRandom(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
