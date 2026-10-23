/**
 * Bootstraps historical readings and baselines for newly onboarded oracle
 * sources.
 *
 *   npx ts-node scripts/oracle-bootstrap.ts --feed stablecoin-depeg \
 *     --source cg-usdc:coingecko:coinId=usd-coin
 *
 * In a built image, run the compiled entry point directly:
 *   node dist/oracle/bootstrap/bootstrap.cli.js --help
 */
import { runBootstrapCli } from "../src/oracle/bootstrap/bootstrap.cli";

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
