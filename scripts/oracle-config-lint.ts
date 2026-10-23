/**
 * Lints an oracle feed / quorum config with the backend's startup rules.
 *
 *   npx ts-node scripts/oracle-config-lint.ts --file config/oracle-feeds.json --network mainnet
 *
 * In a built image, run the compiled entry point directly:
 *   node dist/oracle/config/oracle-config-lint.cli.js --help
 */
import { runOracleConfigLint } from "../src/oracle/config/oracle-config-lint.cli";

process.exit(
  runOracleConfigLint(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  })
);
