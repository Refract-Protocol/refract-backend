import * as fs from "fs";
import { canonicalJson } from "./canonical";
import { foldHolds, HoldStatus } from "./claim-hold.service";
import { EvidenceLedger } from "./evidence-ledger";
import { EvidenceEvent } from "./evidence.types";
import { loadMirrorDetectionConfig } from "./fingerprint";
import { governedFeeds, planMirrorActions } from "./mirror-detection";
import { parseReconstructionQuery, reconstructConsensusState, serializeReconstruction } from "./reconstruction";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CliDeps {
  env: NodeJS.ProcessEnv;
  readFile: (path: string) => string;
}

const defaultDeps: CliDeps = { env: process.env, readFile: (p) => fs.readFileSync(p, "utf8") };

const USAGE = `Usage: oracle-ops <command> [options]

Commands (all read-only; they read the persisted evidence ledger):
  reconstruct --feed <id> (--at <ISO-8601> | --ledger <seq>)
      Consensus state of a feed at a past instant (same output as
      GET /api/v1/ops/consensus/feeds/:feedId/state).
  holds [--status <status>]
      Payout-hold queue (e.g. --status escalated).
  mirror-backtest [--feed <id>] [--step-ms <ms>]
      Replays mirror detection across the whole history with the current
      MIRROR_* thresholds and reports every pair that would be penalised.
      Writes nothing.

Common options:
  --ledger-file <path>   Evidence ledger JSONL (default: $EVIDENCE_LEDGER_PATH)
`;

export function parseFlags(argv: string[]): { command?: string; flags: Record<string, string> } {
  const [command, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const eq = arg.indexOf("=");
    if (eq > 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith("--")) {
      flags[arg.slice(2)] = rest[++i];
    } else {
      flags[arg.slice(2)] = "true";
    }
  }
  return { command, flags };
}

export function loadLedgerEvents(flags: Record<string, string>, deps: CliDeps): EvidenceEvent[] {
  const file = flags["ledger-file"] ?? deps.env.EVIDENCE_LEDGER_PATH;
  if (!file) throw new Error("no evidence ledger: pass --ledger-file or set EVIDENCE_LEDGER_PATH");
  return EvidenceLedger.parseJsonl(deps.readFile(file));
}

export function runOracleOpsCli(argv: string[], deps: CliDeps = defaultDeps): CliResult {
  try {
    const { command, flags } = parseFlags(argv);
    if (!command || command === "help" || flags.help) return { exitCode: command ? 0 : 1, stdout: USAGE, stderr: "" };

    if (command === "reconstruct") {
      const query = parseReconstructionQuery(flags.feed ?? "", { at: flags.at, ledger: flags.ledger });
      const events = loadLedgerEvents(flags, deps);
      return { exitCode: 0, stdout: serializeReconstruction(reconstructConsensusState(events, query)), stderr: "" };
    }

    if (command === "holds") {
      const events = loadLedgerEvents(flags, deps);
      const holds = [...foldHolds(events).values()]
        .filter((h) => !flags.status || h.status === (flags.status as HoldStatus))
        .sort((a, b) => a.placedAt - b.placedAt);
      return { exitCode: 0, stdout: `${canonicalJson({ holds })}\n`, stderr: "" };
    }

    if (command === "mirror-backtest") {
      const events = loadLedgerEvents(flags, deps);
      return { exitCode: 0, stdout: `${canonicalJson(mirrorBacktest(events, flags, deps.env))}\n`, stderr: "" };
    }

    return { exitCode: 1, stdout: "", stderr: `unknown command: ${command}\n\n${USAGE}` };
  } catch (err) {
    return { exitCode: 1, stdout: "", stderr: `error: ${err instanceof Error ? err.message : String(err)}\n` };
  }
}

/**
 * Sweeps detection over history in `step` increments (default: half a
 * window). For each pair it reports the strongest evidence seen and whether
 * it would ever have been penalised under the current thresholds.
 */
export function mirrorBacktest(events: EvidenceEvent[], flags: Record<string, string>, env: NodeJS.ProcessEnv) {
  const cfg = loadMirrorDetectionConfig(env);
  const step = flags["step-ms"] ? Number(flags["step-ms"]) : Math.max(1, Math.floor(cfg.windowMs / 2));
  if (!(step > 0)) throw new Error("--step-ms must be a positive number");
  const feeds = flags.feed ? [flags.feed] : governedFeeds(events);
  return {
    thresholds: cfg,
    feeds: feeds.map((feedId) => {
      const times = events.flatMap((e) => (e.kind === "reading" && e.feedId === feedId ? [Math.max(e.recordedAt, e.observedAt)] : []));
      const pairs = new Map<string, { sourceA: string; sourceB: string; wouldPenalise: boolean; firstFlaggedAt: string | null; maxMatchRatio: number; maxInformativeSamples: number }>();
      if (times.length) {
        const first = Math.min(...times);
        const last = Math.max(...times);
        for (let t = Math.min(first + step, last); ; t = Math.min(t + step, last)) {
          for (const a of planMirrorActions(events, feedId, t, cfg).analyses) {
            const key = `${a.sourceA}|${a.sourceB}`;
            const p = pairs.get(key) ?? { sourceA: a.sourceA, sourceB: a.sourceB, wouldPenalise: false, firstFlaggedAt: null, maxMatchRatio: 0, maxInformativeSamples: 0 };
            p.maxMatchRatio = Math.max(p.maxMatchRatio, a.matchRatio);
            p.maxInformativeSamples = Math.max(p.maxInformativeSamples, a.informativeSamples);
            if (a.mirrored && !p.wouldPenalise) {
              p.wouldPenalise = true;
              p.firstFlaggedAt = new Date(t).toISOString();
            }
            pairs.set(key, p);
          }
          if (t >= last) break;
        }
      }
      const list = [...pairs.values()].sort((x, y) => `${x.sourceA}|${x.sourceB}`.localeCompare(`${y.sourceA}|${y.sourceB}`));
      return { feedId, readings: times.length, pairs: list, wouldPenalise: list.filter((p) => p.wouldPenalise).length };
    }),
  };
}
