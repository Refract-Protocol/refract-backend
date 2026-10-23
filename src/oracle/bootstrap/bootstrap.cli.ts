import { Pool } from "pg";
import { BootstrapStore, InMemoryBootstrapStore, PgBootstrapStore } from "./bootstrap.store";
import {
  CoinGeckoHistoryProvider,
  DefiLlamaHistoryProvider,
  HistoryProviderRegistry,
} from "./history-providers";
import { BootstrapSourceSpec, SourceBootstrapService } from "./source-bootstrap.service";

const USAGE = `Usage: oracle-bootstrap --feed <feedId> --source <sourceId>:<adapter>[:key=value,...] [options]

Seeds historical readings, a statistical baseline, and an initial reputation
for each listed source. Repeat --source to bootstrap several sources of one
feed together so they are corroborated against each other.

Options:
  --lookback-days <n>       History to backfill (default 30)
  --interval-minutes <n>    Expected spacing of history points (default 60)
  --min-samples <n>         Minimum usable samples (default 24)
  --tolerance-bps <n>       Peer agreement tolerance (default 100)
  --force                   Re-run sources that are already warm
  --dry-run                 Keep results in memory; do not write to Postgres
  --json                    Print the reports as JSON

Example:
  oracle-bootstrap --feed stablecoin-depeg \\
    --source cg-usdc:coingecko:coinId=usd-coin --source cg-usdt:coingecko:coinId=tether`;

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface ParsedArgs {
  feedId: string;
  sources: BootstrapSourceSpec[];
  lookbackDays: number;
  intervalMinutes: number;
  minSamples: number;
  toleranceBps: number;
  force: boolean;
  dryRun: boolean;
  json: boolean;
}

/** Parses `<sourceId>:<adapter>[:key=value,...]`. */
export function parseSourceSpec(raw: string): BootstrapSourceSpec {
  const [sourceId, adapter, paramList] = raw.split(":");
  if (!sourceId || !adapter) {
    throw new Error(`Invalid --source "${raw}"; expected <sourceId>:<adapter>[:key=value,...]`);
  }
  const params: Record<string, string> = {};
  for (const pair of (paramList ?? "").split(",").filter(Boolean)) {
    const [name, ...rest] = pair.split("=");
    if (!name || rest.length === 0) throw new Error(`Invalid source parameter "${pair}" in "${raw}"`);
    params[name] = rest.join("=");
  }
  return { sourceId, adapter, params };
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    feedId: "",
    sources: [],
    lookbackDays: 30,
    intervalMinutes: 60,
    minSamples: 24,
    toleranceBps: 100,
    force: false,
    dryRun: false,
    json: false,
  };
  const positiveInt = (flag: string, value: string | undefined): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer`);
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--feed":
        parsed.feedId = argv[++i] ?? "";
        break;
      case "--source":
        parsed.sources.push(parseSourceSpec(argv[++i] ?? ""));
        break;
      case "--lookback-days":
        parsed.lookbackDays = positiveInt(arg, argv[++i]);
        break;
      case "--interval-minutes":
        parsed.intervalMinutes = positiveInt(arg, argv[++i]);
        break;
      case "--min-samples":
        parsed.minSamples = positiveInt(arg, argv[++i]);
        break;
      case "--tolerance-bps":
        parsed.toleranceBps = positiveInt(arg, argv[++i]);
        break;
      case "--force":
        parsed.force = true;
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--json":
        parsed.json = true;
        break;
      default:
        throw new Error(`Unknown argument "${arg}"`);
    }
  }

  if (!parsed.feedId) throw new Error("--feed is required");
  if (parsed.sources.length === 0) throw new Error("At least one --source is required");
  return parsed;
}

export interface CliDeps {
  store?: BootstrapStore;
  providers?: HistoryProviderRegistry;
}

/** Returns the process exit code: 0 all warm, 1 some source not warm, 2 usage error. */
export async function runBootstrapCli(
  argv: string[],
  io: CliIo,
  env: NodeJS.ProcessEnv = process.env,
  deps: CliDeps = {}
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.out(USAGE);
    return 0;
  }

  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(USAGE);
    return 2;
  }

  let pool: Pool | undefined;
  let store = deps.store;
  if (!store) {
    if (!args.dryRun && env.DATABASE_URL) {
      pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });
      store = new PgBootstrapStore(pool);
    } else {
      if (!args.dryRun) io.err("DATABASE_URL is not set; running as --dry-run");
      store = new InMemoryBootstrapStore();
    }
  }

  const providers =
    deps.providers ??
    new HistoryProviderRegistry([new CoinGeckoHistoryProvider(), new DefiLlamaHistoryProvider()]);
  const service = new SourceBootstrapService(store, providers);

  try {
    const reports = await service.bootstrapFeed(args.feedId, args.sources, {
      lookbackMs: args.lookbackDays * 24 * 60 * 60 * 1000,
      expectedIntervalMs: args.intervalMinutes * 60 * 1000,
      minSamples: args.minSamples,
      corroborationToleranceBps: args.toleranceBps,
      force: args.force,
      requestedBy: env.USER ? `cli:${env.USER}` : "cli",
    });

    if (args.json) {
      io.out(JSON.stringify(reports, null, 2));
    } else {
      for (const r of reports) {
        const detail = r.skipped
          ? "skipped (already warm; pass --force to re-run)"
          : r.status === "warm"
            ? `${r.sampleCount} samples, coverage ${r.coverage}, corroboration ${r.corroboration ?? "n/a"}, reputation ${r.reputation}`
            : (r.error ?? "");
        io.out(`${args.feedId}/${r.sourceId}: ${r.status} — ${detail}`);
      }
    }
    return reports.every((r) => r.status === "warm") ? 0 : 1;
  } finally {
    await pool?.end();
  }
}

if (require.main === module) {
  runBootstrapCli(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  }).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exit(2);
    }
  );
}
