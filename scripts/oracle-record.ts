/**
 * Records a versioned oracle replay fixture from live provider endpoints.
 *
 *   ORACLE_RECORD_SOURCES='{"provider-a":"https://...","provider-b":"https://..."}' \
 *   ORACLE_RECORD_HEADERS_provider_a='Bearer ...' (optional, never written to disk) \
 *   npx ts-node scripts/oracle-record.ts <fixture-name> [--feed rainfall-mm-24h] [--samples 3] [--interval-ms 60000]
 *
 * Each endpoint must return JSON with numeric `value` and `observedAt` (epoch ms)
 * fields. Only those two fields are persisted — URLs, headers, and any other
 * response content are discarded, so fixtures carry no secrets or PII.
 */
import * as fs from "fs";
import * as path from "path";
import {
  Fixture,
  FixtureSample,
  fixtureChecksum,
  systemClock,
} from "../src/oracle/replay";

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name || name.startsWith("--") || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error("Usage: oracle-record.ts <fixture-name> [--feed f] [--samples n] [--interval-ms ms]");
  }
  const endpoints = JSON.parse(process.env.ORACLE_RECORD_SOURCES ?? "") as Record<string, string>;
  const samples = Number(flag("samples", "3"));
  const intervalMs = Number(flag("interval-ms", "60000"));
  const feed = flag("feed", "unknown");

  const startedAt = systemClock.now();
  const sources: Record<string, FixtureSample[]> = {};
  for (const s of Object.keys(endpoints)) {
    sources[s] = [];
  }

  for (let i = 0; i < samples; i++) {
    const offsetMs = systemClock.now() - startedAt;
    for (const [source, url] of Object.entries(endpoints)) {
      const authKey = `ORACLE_RECORD_HEADERS_${source.replace(/[^a-zA-Z0-9]/g, "_")}`;
      const res = await fetch(url, {
        headers: process.env[authKey] ? { Authorization: process.env[authKey] as string } : {},
      });
      if (!res.ok) {
        throw new Error(`${source}: HTTP ${res.status}`);
      }
      const body = (await res.json()) as { value?: unknown; observedAt?: unknown };
      if (typeof body.value !== "number" || typeof body.observedAt !== "number") {
        throw new Error(`${source}: response lacks numeric value/observedAt`);
      }
      sources[source].push({
        offsetMs,
        value: body.value,
        observedOffsetMs: body.observedAt - startedAt,
      });
    }
    if (i < samples - 1) {
      await systemClock.sleep(intervalMs);
    }
  }

  const unsigned: Omit<Fixture, "checksum"> = {
    version: 1,
    feed,
    recordedAt: new Date(startedAt).toISOString(),
    sources,
  };
  const fixture: Fixture = { ...unsigned, checksum: fixtureChecksum(unsigned) };
  const out = path.join(__dirname, "../test/fixtures/oracle", `${name}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`Wrote ${out}`);
}

main().catch((err: Error) => {
  console.error(`oracle-record failed: ${err.message}`);
  process.exit(1);
});
