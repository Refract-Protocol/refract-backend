import { createHash } from "crypto";
import * as fs from "fs";
import { Clock, Fault, Fixture, ProviderClient, ProviderError } from "./types";

export function fixtureChecksum(f: Omit<Fixture, "checksum">): string {
  const canonical = JSON.stringify({
    version: f.version,
    feed: f.feed,
    recordedAt: f.recordedAt,
    sources: f.sources,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Loads a fixture and fails loudly on corruption or unknown version. */
export function loadFixture(file: string): Fixture {
  let parsed: Fixture;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Fixture;
  } catch (err) {
    throw new Error(`Cannot read fixture ${file}: ${(err as Error).message}`);
  }
  if (parsed.version !== 1) {
    throw new Error(`Fixture ${file}: unsupported version ${String(parsed.version)}`);
  }
  if (!parsed.sources || typeof parsed.sources !== "object") {
    throw new Error(`Fixture ${file}: missing sources`);
  }
  if (fixtureChecksum(parsed) !== parsed.checksum) {
    throw new Error(`Fixture ${file}: checksum mismatch (corrupted or hand-edited)`);
  }
  return parsed;
}

/** Serves recorded samples relative to a start time on the injected clock. */
export class ReplayProviderClient implements ProviderClient {
  constructor(
    private readonly fixture: Fixture,
    private readonly clock: Clock,
    private readonly startMs: number,
  ) {}

  async fetch(source: string): Promise<unknown> {
    const samples = this.fixture.sources[source];
    if (!samples || samples.length === 0) {
      throw new Error(`Fixture has no samples for source "${source}"`);
    }
    const elapsed = this.clock.now() - this.startMs;
    let current = samples[0];
    for (const s of samples) {
      if (s.offsetMs <= elapsed) {
        current = s;
      }
    }
    return {
      value: current.value,
      observedAt: this.startMs + current.observedOffsetMs,
    };
  }
}

/** Wraps any ProviderClient and applies declarative faults by clock time. */
export class FaultInjectingClient implements ProviderClient {
  constructor(
    private readonly inner: ProviderClient,
    private readonly faults: Fault[],
    private readonly clock: Clock,
    private readonly startMs: number,
  ) {}

  async fetch(source: string): Promise<unknown> {
    const elapsed = this.clock.now() - this.startMs;
    const active = this.faults.filter(
      (f) =>
        elapsed >= f.fromMs &&
        elapsed < f.toMs &&
        (f.kind === "all_down" || f.source === source),
    );

    for (const f of active) {
      switch (f.kind) {
        case "timeout":
          throw new ProviderError("timeout", `${source} timed out`);
        case "http_5xx":
          throw new ProviderError("http_5xx", `${source} returned 503`);
        case "all_down":
          throw new ProviderError("timeout", "all sources down");
        case "malformed":
          return { value: "NaN", observedAt: null };
        default:
          break;
      }
    }

    const payload = (await this.inner.fetch(source)) as {
      value: number;
      observedAt: number;
    };
    let { value, observedAt } = payload;
    for (const f of active) {
      if (f.kind === "diverge") {
        value *= f.param ?? 1;
      } else if (f.kind === "delay") {
        observedAt -= f.param ?? 0;
      } else if (f.kind === "clock_skew") {
        observedAt += f.param ?? 0;
      }
    }
    return { value, observedAt };
  }
}
