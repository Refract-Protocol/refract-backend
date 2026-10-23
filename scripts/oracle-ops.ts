/**
 * Operator / auditor CLI for the consensus evidence ledger.
 *
 *   npm run oracle:ops -- reconstruct --feed StablecoinDepeg --at 2026-10-21T14:00:00Z
 *   npm run oracle:ops -- holds --status escalated
 *
 * All commands are read-only and work from the persisted ledger file
 * (EVIDENCE_LEDGER_PATH or --ledger-file), never from a running server.
 */
import { runOracleOpsCli } from "../src/oracle/consensus/cli";

const result = runOracleOpsCli(process.argv.slice(2));
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.exitCode);
