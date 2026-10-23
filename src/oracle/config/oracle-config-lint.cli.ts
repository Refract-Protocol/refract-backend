import { readFileSync } from "node:fs";
import { LoadedOracleConfig, OracleConfigParseError, loadOracleConfig } from "./oracle-feed-config";
import { formatReport, validateOracleConfig } from "./oracle-config.validator";

const USAGE = `Usage: oracle-config-lint [--file <path>] [--network <testnet|futurenet|mainnet>] [--strict] [--json]

Checks an oracle feed and quorum config with the same rules the backend
applies at startup. Without --file, it reads ORACLE_FEEDS_FILE or
ORACLE_FEEDS_JSON, or falls back to the built-in feeds.

  --file <path>     Config file to check
  --network <name>  Network to check against (default: STELLAR_NETWORK or testnet)
  --strict          Treat warnings as errors
  --json            Print the report as JSON

Exit codes: 0 valid, 1 invalid, 2 usage error or unreadable/malformed config.`;

export interface LintIo {
  out(line: string): void;
  err(line: string): void;
}

export function runOracleConfigLint(
  argv: string[],
  io: LintIo,
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8")
): number {
  let file: string | undefined;
  let network = env.STELLAR_NETWORK ?? "testnet";
  let strict = false;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      io.out(USAGE);
      return 0;
    } else if (arg === "--file" && argv[i + 1]) {
      file = argv[++i];
    } else if (arg === "--network" && argv[i + 1]) {
      network = argv[++i];
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--json") {
      json = true;
    } else {
      io.err(`Unknown or incomplete argument "${arg}"`);
      io.err(USAGE);
      return 2;
    }
  }

  let loaded: LoadedOracleConfig;
  try {
    const source: NodeJS.ProcessEnv = file
      ? { ...env, ORACLE_FEEDS_FILE: file, ORACLE_FEEDS_JSON: undefined }
      : env;
    loaded = loadOracleConfig(source, readFile);
  } catch (error) {
    if (json && error instanceof OracleConfigParseError) {
      io.out(JSON.stringify({ valid: false, origin: error.origin, parseErrors: error.issues }, null, 2));
    } else {
      io.err(error instanceof Error ? error.message : String(error));
    }
    return 2;
  }

  const report = validateOracleConfig(loaded.config, { network, env });
  const valid = report.errors.length === 0 && (!strict || report.warnings.length === 0);

  if (json) {
    io.out(JSON.stringify({ valid, origin: loaded.origin, network, strict, ...report }, null, 2));
  } else {
    (valid ? io.out : io.err)(formatReport(report, loaded.origin));
    io.out(valid ? "OK" : "FAILED");
  }
  return valid ? 0 : 1;
}

if (require.main === module) {
  process.exit(
    runOracleConfigLint(process.argv.slice(2), {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    })
  );
}
