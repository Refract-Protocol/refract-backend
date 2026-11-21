/**
 * Lints an oracle feed / quorum config with the backend's startup rules.
 *
 *   npx ts-node scripts/oracle-config-lint.ts --file config/oracle-feeds.json --network mainnet
 *   npx ts-node scripts/oracle-config-lint.ts --file config/oracle-feeds.json --strict
 *
 * In a built image, run the compiled entry point directly:
 *   node dist/oracle/config/oracle-config-lint.cli.js --help
 *
 * Exit codes (CI gate contract):
 *   0  clean config (no errors, and no warnings when --strict is passed)
 *   1  findings: errors always fail; warnings fail only with --strict
 *   2  usage error or unreadable/malformed config
 */
import { runOracleConfigLint } from "../src/oracle/config/oracle-config-lint.cli";

process.exitCode = runOracleConfigLint(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
