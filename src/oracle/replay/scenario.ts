import * as fs from "fs";
import * as path from "path";
import { ManualClock, seededRandom } from "./clock";
import { OraclePipeline } from "./pipeline";
import {
  FaultInjectingClient,
  ReplayProviderClient,
  loadFixture,
} from "./providers";
import { Decision, FaultKind, Scenario } from "./types";

const FAULT_KINDS: FaultKind[] = [
  "timeout",
  "http_5xx",
  "malformed",
  "diverge",
  "all_down",
  "delay",
  "clock_skew",
];

export interface ScenarioPaths {
  scenarioDir: string;
  fixtureDir: string;
}

export function defaultPaths(root: string): ScenarioPaths {
  return {
    scenarioDir: path.join(root, "test/oracle/replay/scenarios"),
    fixtureDir: path.join(root, "test/fixtures/oracle"),
  };
}

export function listScenarios(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

/** Loads a scenario by name; unknown names and bad definitions throw. */
export function loadScenario(name: string, dir: string): Scenario {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`Invalid scenario name "${name}"`);
  }
  const file = path.join(dir, `${name}.json`);
  if (!fs.existsSync(file)) {
    const known = listScenarios(dir).join(", ") || "(none)";
    throw new Error(`Unknown scenario "${name}". Known scenarios: ${known}`);
  }
  const scenario = JSON.parse(fs.readFileSync(file, "utf8")) as Scenario;
  if (scenario.name !== name) {
    throw new Error(`Scenario file ${file} declares name "${scenario.name}"`);
  }
  for (const f of scenario.faults) {
    if (!FAULT_KINDS.includes(f.kind)) {
      throw new Error(`Scenario "${name}": unknown fault kind "${f.kind}"`);
    }
  }
  if (scenario.expect && scenario.expect.length !== scenario.ticks.length) {
    throw new Error(`Scenario "${name}": expect length must match ticks length`);
  }
  return scenario;
}

export interface ScenarioResult {
  scenario: string;
  seed: number;
  decisions: Decision[];
}

/** Runs a scenario; same fixture + seed + clock => byte-identical output. */
export async function runScenario(
  scenario: Scenario,
  fixtureDir: string,
): Promise<ScenarioResult> {
  const fixture = loadFixture(path.join(fixtureDir, scenario.fixture));
  const clock = new ManualClock(scenario.startMs);
  const client = new FaultInjectingClient(
    new ReplayProviderClient(fixture, clock, scenario.startMs),
    scenario.faults,
    clock,
    scenario.startMs,
  );
  const pipeline = new OraclePipeline(
    scenario.config,
    client,
    clock,
    seededRandom(scenario.seed),
  );

  const ticks = [...scenario.ticks].sort((a, b) => a - b);
  const decisions: Decision[] = [];
  for (const tick of ticks) {
    clock.setTime(scenario.startMs + tick);
    decisions.push(await pipeline.evaluate());
  }

  if (scenario.expect) {
    scenario.expect.forEach((action, i) => {
      if (decisions[i].action !== action) {
        throw new Error(
          `Scenario "${scenario.name}" tick ${ticks[i]}: expected ${action}, got ${decisions[i].action} (${decisions[i].reason})`,
        );
      }
    });
  }
  return { scenario: scenario.name, seed: scenario.seed, decisions };
}
