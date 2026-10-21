import * as fs from "fs";
import { canonicalJson } from "./canonical";
import { foldHolds, HoldStatus } from "./claim-hold.service";
import { EvidenceLedger } from "./evidence-ledger";
import { EvidenceEvent } from "./evidence.types";
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

    return { exitCode: 1, stdout: "", stderr: `unknown command: ${command}\n\n${USAGE}` };
  } catch (err) {
    return { exitCode: 1, stdout: "", stderr: `error: ${err instanceof Error ? err.message : String(err)}\n` };
  }
}
