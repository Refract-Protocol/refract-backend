/**
 * Operator CLI: inspect oracle feeds and apply audited manual overrides.
 *
 *   npx ts-node scripts/operator-cli.ts <command> [args] [flags]
 *
 * Read-only commands query Postgres directly and work while the service is down.
 * Mutating commands go through OperatorControls (single transaction + audit row).
 */
import { Pool } from "pg";
import { MutationAction, OperatorControls } from "../src/oracle/operator-controls";

const USAGE = `Usage: operator-cli <command> [args] [flags]

Read-only:
  feeds                         List feeds with pause state and health
  readings <feed> [--limit N]   Recent readings grouped by source
  decisions [--limit N]         Recent claim decisions with evidence links
  audit [--limit N]             Recent operator actions

Mutating (require --reason; operator from --operator or OPERATOR_ID):
  pause <feed>                  Pause a feed            (requires --yes)
  resume <feed>                 Resume a feed
  quarantine <source>           Quarantine a source     (requires --yes)
  unquarantine <source>         Release a source

Flags: --reason <text>  --operator <id>  --dry-run  --yes  --limit <n>  --help`;

const MUTATIONS: Record<string, { action: MutationAction; destructive: boolean }> = {
  pause: { action: "pause_feed", destructive: true },
  resume: { action: "resume_feed", destructive: false },
  quarantine: { action: "quarantine_source", destructive: true },
  unquarantine: { action: "unquarantine_source", destructive: false },
};

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

const VALUE_FLAGS = new Set(["reason", "operator", "limit"]);
const BOOL_FLAGS = new Set(["dry-run", "yes", "help"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      rest.push(a);
      continue;
    }
    const name = a.slice(2);
    if (BOOL_FLAGS.has(name)) {
      flags[name] = true;
    } else if (VALUE_FLAGS.has(name)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${name} requires a value`);
      flags[name] = v;
    } else {
      throw new Error(`unknown flag --${name}`);
    }
  }
  const [command = "", ...positional] = rest;
  return { command, positional, flags };
}

function limitOf(flags: ParsedArgs["flags"]): number {
  if (flags.limit === undefined) return 20;
  const n = Number(flags.limit);
  if (!Number.isInteger(n) || n < 1 || n > 500) throw new Error("--limit must be an integer between 1 and 500");
  return n;
}

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  if (!command || flags.help) {
    console.log(USAGE);
    return;
  }
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not set");
  const pool = new Pool({ connectionString: url });
  const ops = new OperatorControls(pool);

  try {
    if (command === "feeds") {
      console.table(
        (await ops.listFeeds()).map((f) => ({
          feed: f.coverageType,
          health: f.health,
          paused: f.paused,
          lastReading: f.lastReadingAt?.toISOString() ?? "-",
          lastSource: f.lastSource ?? "-",
          "readings/1h": f.readings1h,
          pauseReason: f.pauseReason ?? "",
        }))
      );
    } else if (command === "readings") {
      if (!positional[0]) throw new Error("readings requires <feed>");
      for (const [source, rows] of await ops.recentReadings(positional[0], limitOf(flags))) {
        console.log(`\n${source}${rows[0].quarantined ? "  [QUARANTINED]" : ""}`);
        for (const r of rows) {
          console.log(`  ${new Date(r.recorded_at).toISOString()}  value=${r.value}  severity=${r.severity}`);
        }
      }
    } else if (command === "decisions") {
      console.table(
        (await ops.recentDecisions(limitOf(flags))).map((d) => ({
          claim: d.id,
          feed: d.coverage_type,
          triggerValue: d.trigger_value,
          source: d.trigger_source,
          processedAt: new Date(d.processed_at).toISOString(),
          evidence: d.evidence ?? "-",
        }))
      );
    } else if (command === "audit") {
      console.table(await ops.recentAudit(limitOf(flags)));
    } else if (MUTATIONS[command]) {
      const { action, destructive } = MUTATIONS[command];
      const target = positional[0];
      if (!target) throw new Error(`${command} requires a target`);
      const dryRun = flags["dry-run"] === true;
      if (destructive && !dryRun && flags.yes !== true) {
        throw new Error(`${command} is high-impact: re-run with --yes to confirm, or --dry-run to preview`);
      }
      const res = await ops.mutate({
        action,
        target,
        operator: String(flags.operator ?? process.env.OPERATOR_ID ?? ""),
        reason: String(flags.reason ?? ""),
        dryRun,
      });
      console.log(`${res.dryRun ? "[dry-run] would apply" : "applied"} ${res.action} on ${res.target}`);
      console.log(`  changed: ${res.changed}`);
      console.log(`  before:  ${JSON.stringify(res.before)}`);
      console.log(`  after:   ${JSON.stringify(res.after)}`);
    } else {
      throw new Error(`unknown command "${command}"\n\n${USAGE}`);
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
