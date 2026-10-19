import type { SyntheticReading } from "./synthetic-workload";

/**
 * The seam between the load generator and the real oracle pipeline.
 *
 * Implementations must push `readings` through the production code path:
 * source ingestion, corroboration, anomaly checks, decision persistence and
 * publishing. Sources are replaced by a fake adapter and publishing by a stub
 * publisher, so the measurement isolates oracle logic from network variance.
 */
export interface PipelinePort {
  /** Runs one decision for a feed and returns the number of DB writes it caused. */
  decide(
    feedId: string,
    readings: SyntheticReading[],
    payoutTriggering: boolean,
  ): Promise<{ dbWrites: number }>;
  close(): Promise<void>;
}

export interface PipelinePortOptions {
  databaseUrl: string;
  redisUrl: string;
}

export async function createPipelinePort(
  _options: PipelinePortOptions,
): Promise<PipelinePort> {
  throw new Error(
    "Load pipeline port is not wired. Implement createPipelinePort() to build " +
      "the oracle pipeline from its Nest module, with a fake source adapter and " +
      "stub publisher, against the LOAD_DATABASE_URL / LOAD_REDIS_URL services.",
  );
}
