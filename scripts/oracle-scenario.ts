/**
 * Runs a named oracle replay scenario end-to-end and prints the decisions as JSON.
 *
 *   npx ts-node scripts/oracle-scenario.ts <scenario-name>
 *   npx ts-node scripts/oracle-scenario.ts --list
 *
 * Exits non-zero for an unknown scenario, a corrupted fixture, or when the
 * decisions do not match the scenario's `expect` list.
 */
import * as path from "path";
import {
  defaultPaths,
  listScenarios,
  loadScenario,
  runScenario,
} from "../src/oracle/replay";

async function main(): Promise<void> {
  const arg = process.argv[2];
  const paths = defaultPaths(path.join(__dirname, ".."));

  if (!arg || arg === "--list") {
    console.log(listScenarios(paths.scenarioDir).join("\n"));
    return;
  }

  const scenario = loadScenario(arg, paths.scenarioDir);
  const result = await runScenario(scenario, paths.fixtureDir);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err: Error) => {
  console.error(`oracle-scenario failed: ${err.message}`);
  process.exit(1);
});
