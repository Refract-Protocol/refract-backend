import { readFileSync } from "node:fs";
import { z } from "zod";
import { CoverageTypeName } from "../../common/coverage-type.map";

/**
 * How a feed combines its sources into one reading.
 *
 *  - `single_source`   — one source is trusted outright. Only acceptable off
 *                        mainnet or for feeds that never settle claims.
 *  - `median_quorum`   — median of at least `quorum.minSources` fresh,
 *                        independent sources that agree within
 *                        `quorum.maxDeviationBps`.
 *  - `weighted_quorum` — like `median_quorum`, weighted by each source's
 *                        `weight`.
 */
export const TRUST_MODES = ["single_source", "median_quorum", "weighted_quorum"] as const;
export type TrustMode = (typeof TRUST_MODES)[number];

/** Source adapters this backend can poll. `mock` returns synthetic data. */
export const KNOWN_ADAPTERS = ["coingecko", "defillama", "horizon", "mock"] as const;

const sourceSchema = z
  .object({
    id: z.string().min(1),
    adapter: z.string().min(1),
    /**
     * Who ultimately runs the data behind this source. Sources with the same
     * operator are one independent source for quorum purposes. Defaults to
     * the adapter name.
     */
    operator: z.string().min(1).optional(),
    params: z.record(z.string()).optional(),
    enabled: z.boolean().optional(),
    weight: z.number().optional(),
  })
  .strict();

const quorumSchema = z
  .object({
    minSources: z.number().int(),
    maxDeviationBps: z.number().int().optional(),
  })
  .strict();

const publishSchema = z
  .object({
    mode: z.enum(["on_change", "every_poll"]).optional(),
    minIntervalMs: z.number().int().optional(),
  })
  .strict();

const feedSchema = z
  .object({
    id: z.string().min(1),
    coverageType: z.string().min(1),
    trustMode: z.string().optional(),
    pollIntervalMs: z.number().int().optional(),
    freshnessWindowMs: z.number().int().optional(),
    quorum: quorumSchema.optional(),
    sources: z.array(sourceSchema),
    publish: publishSchema.optional(),
    /** Whether readings from this feed can trigger claim settlement. Default true. */
    settlesClaims: z.boolean().optional(),
  })
  .strict();

export const oracleConfigSchema = z
  .object({
    version: z.literal(1),
    defaults: z
      .object({
        trustMode: z.string().optional(),
        pollIntervalMs: z.number().int().optional(),
        freshnessWindowMs: z.number().int().optional(),
        maxDeviationBps: z.number().int().optional(),
        publish: publishSchema.optional(),
      })
      .strict()
      .optional(),
    feeds: z.array(feedSchema),
  })
  .strict();

export type OracleConfigFile = z.infer<typeof oracleConfigSchema>;
export type OracleFeedDefinition = z.infer<typeof feedSchema>;
export type OracleSourceDefinition = z.infer<typeof sourceSchema>;

/** A feed with defaults applied. `trustMode` stays undefined when nothing set it. */
export interface ResolvedFeed {
  id: string;
  coverageType: string;
  trustMode: string | undefined;
  pollIntervalMs: number;
  freshnessWindowMs: number;
  minSources: number;
  maxDeviationBps: number;
  publishMode: "on_change" | "every_poll";
  publishMinIntervalMs: number;
  settlesClaims: boolean;
  sources: Array<OracleSourceDefinition & { operator: string; enabled: boolean }>;
}

export const FEED_DEFAULTS = {
  pollIntervalMs: 60_000,
  freshnessWindowMs: 300_000,
  maxDeviationBps: 100,
  publishMinIntervalMs: 300_000,
} as const;

export function resolveFeeds(config: OracleConfigFile, env: NodeJS.ProcessEnv = process.env): ResolvedFeed[] {
  const defaults = config.defaults ?? {};
  const envPublishMode = env.ORACLE_PUBLISH_MODE === "every_poll" ? "every_poll" : "on_change";
  const envPublishInterval = Number(env.ORACLE_PUBLISH_MIN_INTERVAL_MS);

  return config.feeds.map((feed) => ({
    id: feed.id,
    coverageType: feed.coverageType,
    trustMode: feed.trustMode ?? defaults.trustMode,
    pollIntervalMs: feed.pollIntervalMs ?? defaults.pollIntervalMs ?? FEED_DEFAULTS.pollIntervalMs,
    freshnessWindowMs:
      feed.freshnessWindowMs ?? defaults.freshnessWindowMs ?? FEED_DEFAULTS.freshnessWindowMs,
    minSources: feed.quorum?.minSources ?? 1,
    maxDeviationBps:
      feed.quorum?.maxDeviationBps ?? defaults.maxDeviationBps ?? FEED_DEFAULTS.maxDeviationBps,
    publishMode: feed.publish?.mode ?? defaults.publish?.mode ?? envPublishMode,
    publishMinIntervalMs:
      feed.publish?.minIntervalMs ??
      defaults.publish?.minIntervalMs ??
      (Number.isInteger(envPublishInterval) ? envPublishInterval : FEED_DEFAULTS.publishMinIntervalMs),
    settlesClaims: feed.settlesClaims ?? true,
    sources: feed.sources.map((source) => ({
      ...source,
      operator: source.operator ?? source.adapter,
      enabled: source.enabled ?? true,
    })),
  }));
}

/**
 * The feeds the backend polls when no config file is supplied. It mirrors the
 * built-in OracleService sources: one source per coverage type, two of them
 * mocked. It is fine for local and testnet use, but the validator rejects it
 * on mainnet, so a production deployment must ship an explicit quorum config.
 */
export const BUILT_IN_ORACLE_CONFIG: OracleConfigFile = {
  version: 1,
  defaults: { trustMode: "single_source" },
  feeds: [
    {
      id: "stablecoin-depeg",
      coverageType: CoverageTypeName.StablecoinDepeg,
      sources: [{ id: "coingecko-usdc", adapter: "coingecko", params: { coinId: "usd-coin" } }],
    },
    {
      id: "market-crash",
      coverageType: CoverageTypeName.MarketCrash,
      sources: [{ id: "coingecko-xlm", adapter: "coingecko", params: { coinId: "stellar" } }],
    },
    {
      id: "smart-contract-risk",
      coverageType: CoverageTypeName.SmartContractRisk,
      sources: [{ id: "defillama-tvl", adapter: "defillama", params: { protocolSlug: "aave" } }],
    },
    {
      id: "liquidation-shield",
      coverageType: CoverageTypeName.LiquidationShield,
      sources: [{ id: "mock-liquidations", adapter: "mock" }],
    },
    {
      id: "flight-delay",
      coverageType: CoverageTypeName.FlightDelay,
      sources: [{ id: "mock-flights", adapter: "mock" }],
    },
  ],
};

export interface LoadedOracleConfig {
  config: OracleConfigFile;
  /** Where the config came from, for error messages. */
  origin: string;
}

export class OracleConfigParseError extends Error {
  constructor(
    readonly origin: string,
    readonly issues: string[]
  ) {
    super(`Oracle feed config ${origin} is malformed:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
  }
}

/** Parses and structurally checks a config document. Semantic rules live in the validator. */
export function parseOracleConfig(raw: unknown, origin: string): OracleConfigFile {
  const result = oracleConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new OracleConfigParseError(
      origin,
      result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    );
  }
  return result.data;
}

/**
 * Loads the feed config from `ORACLE_FEEDS_FILE` (a JSON file path) or
 * `ORACLE_FEEDS_JSON` (inline JSON), falling back to the built-in feeds.
 */
export function loadOracleConfig(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8")
): LoadedOracleConfig {
  const file = env.ORACLE_FEEDS_FILE?.trim();
  const inline = env.ORACLE_FEEDS_JSON?.trim();

  if (file && inline) {
    throw new OracleConfigParseError("(environment)", [
      "Set only one of ORACLE_FEEDS_FILE and ORACLE_FEEDS_JSON",
    ]);
  }

  if (!file && !inline) {
    return { config: BUILT_IN_ORACLE_CONFIG, origin: "built-in defaults" };
  }

  const origin = file ? `file ${file}` : "ORACLE_FEEDS_JSON";
  let text: string;
  try {
    text = file ? readFile(file) : (inline as string);
  } catch (error) {
    throw new OracleConfigParseError(origin, [
      `cannot read file: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new OracleConfigParseError(origin, [
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  return { config: parseOracleConfig(json, origin), origin };
}
