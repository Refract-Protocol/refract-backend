/**
 * Regenerates golden XDR fixtures under src/stellar/xdr-fixtures/.
 *
 * Run after an intentional ABI / encoder change:
 *   npx ts-node scripts/regenerate-xdr-fixtures.ts
 *
 * Do NOT regenerate to silence a failing test without first confirming whether
 * the contract ABI changed or the encoding regressed.
 */
import * as fs from "fs";
import * as path from "path";
import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  COVERAGE_TYPE_VARIANTS,
  TRIGGER_THRESHOLDS,
  buildPolicyParamsScVal,
  encodeOraclePublishArgs,
  encodeProcessClaimArg,
  encodeProvideCapitalArgs,
  encodeWithdrawCapitalArgs,
} from "../src/stellar/scval-encoders";

const outDir = path.join(__dirname, "../src/stellar/xdr-fixtures");

// ---------------------------------------------------------------------------
// Disaster-recovery restore drill (issue #296).
//
// This entrypoint is intentionally kept in this file so the drill can be run
// with the same toolchain as the fixture regeneration script:
//
//   npx ts-node scripts/regenerate-xdr-fixtures.ts --restore-drill
//
// The drill is idempotent and env-driven. It never touches production: the
// target must be an ephemeral database whose name is prefixed with
// `drill_` (or `DRILL_ALLOW_TARGET=1` explicitly set for a disposable CI DB).
//
// Environment:
//   BACKUP_SOURCE        path to a pg_dump custom/plain logical dump (required)
//   BACKUP_TAKEN_AT      ISO-8601 timestamp of the backup (optional; falls back
//                        to file mtime). Used to compute the data-loss window.
//   RPO_TARGET_SECONDS   max acceptable backup age (default 3600)
//   DRILL_TARGET_URL     postgres:// URL of the ephemeral target instance
//   DRILL_DB_NAME        database name to create/use (default drill_restore)
//   DRILL_MIGRATIONS_DIR migrations directory (default src/db/migrations)
//   DRILL_REPORT_PATH    report artifact path (default artifacts/restore-drill.json)
//   DRILL_METRICS_URL    optional metrics endpoint to POST the outcome to
//   DRILL_ROW_TOLERANCE  fractional row-count tolerance (default 0.02)
//   DRILL_ALLOW_TARGET   set to 1 to allow a non `drill_` target database
//   DRILL_KEEP           set to 1 to skip teardown (debugging only)
// ---------------------------------------------------------------------------

import { execFileSync } from "child_process";

interface DrillConfig {
  backupSource: string;
  backupTakenAt: Date;
  rpoTargetSeconds: number;
  targetUrl: string;
  dbName: string;
  migrationsDir: string;
  reportPath: string;
  metricsUrl?: string;
  rowTolerance: number;
  allowTarget: boolean;
  keep: boolean;
}

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

interface DrillReport {
  status: "pass" | "fail";
  startedAt: string;
  finishedAt: string;
  restoreDurationSeconds: number;
  dataLossWindowSeconds: number;
  rpoTargetSeconds: number;
  backupTakenAt: string;
  checks: CheckResult[];
  diagnostics: string[];
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

function loadDrillConfig(): DrillConfig {
  const backupSource = env("BACKUP_SOURCE");
  if (!backupSource) throw new Error("BACKUP_SOURCE is required");
  if (!fs.existsSync(backupSource)) throw new Error(`BACKUP_SOURCE not found: ${backupSource}`);

  const targetUrl = env("DRILL_TARGET_URL");
  if (!targetUrl) throw new Error("DRILL_TARGET_URL is required");

  const dbName = env("DRILL_DB_NAME") ?? "drill_restore";
  const allowTarget = env("DRILL_ALLOW_TARGET") === "1";
  if (!allowTarget && !dbName.startsWith("drill_")) {
    throw new Error(
      `refusing to run drill against non-ephemeral database "${dbName}" (set DRILL_ALLOW_TARGET=1 to override)`
    );
  }

  const takenRaw = env("BACKUP_TAKEN_AT");
  const backupTakenAt = takenRaw ? new Date(takenRaw) : fs.statSync(backupSource).mtime;
  if (Number.isNaN(backupTakenAt.getTime())) {
    throw new Error(`invalid BACKUP_TAKEN_AT: ${takenRaw}`);
  }

  return {
    backupSource,
    backupTakenAt,
    rpoTargetSeconds: Number(env("RPO_TARGET_SECONDS") ?? "3600"),
    targetUrl,
    dbName,
    migrationsDir: env("DRILL_MIGRATIONS_DIR") ?? path.join(__dirname, "../src/db/migrations"),
    reportPath: env("DRILL_REPORT_PATH") ?? path.join(__dirname, "../artifacts/restore-drill.json"),
    metricsUrl: env("DRILL_METRICS_URL"),
    rowTolerance: Number(env("DRILL_ROW_TOLERANCE") ?? "0.02"),
    allowTarget,
    keep: env("DRILL_KEEP") === "1",
  };
}

function psql(url: string, args: string[], input?: string): string {
  return execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-tA", ...args], {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = "/postgres";
  return u.toString();
}

function provisionDatabase(cfg: DrillConfig): void {
  const admin = adminUrl(cfg.targetUrl);
  // Idempotent: drop any leftover from a previous aborted run, then recreate.
  psql(admin, ["-c", `DROP DATABASE IF EXISTS "${cfg.dbName}"`]);
  psql(admin, ["-c", `CREATE DATABASE "${cfg.dbName}"`]);
}

function applyMigrations(cfg: DrillConfig): void {
  const target = withDatabase(cfg.targetUrl, cfg.dbName);
  const files = fs
    .readdirSync(cfg.migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) throw new Error(`no migrations found in ${cfg.migrationsDir}`);
  for (const file of files) {
    const sql = fs.readFileSync(path.join(cfg.migrationsDir, file), "utf8");
    psql(target, ["-f", "-"], sql);
  }
}

function restoreBackup(cfg: DrillConfig): void {
  const target = withDatabase(cfg.targetUrl, cfg.dbName);
  // --clean --if-exists keeps the drill re-runnable against a fresh schema.
  execFileSync(
    "pg_restore",
    ["--clean", "--if-exists", "--no-owner", "--no-privileges", "-d", target, cfg.backupSource],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }
  );
}

function queryScalar(url: string, sql: string): string {
  return psql(url, ["-c", sql]);
}

function tableExists(url: string, table: string): boolean {
  const out = queryScalar(
    url,
    `SELECT to_regclass('public.${table}') IS NOT NULL`
  );
  return out === "t";
}

function checkRowCounts(url: string, tolerance: number): CheckResult {
  // Compare restored counts against the counts recorded in the backup manifest
  // table (written by the backup path). If the manifest is absent we fall back
  // to a self-consistency check: every feed table must be non-empty.
  const tables = ["oracle_feeds", "oracle_evidence", "consensus_decisions", "claims"];
  const missing = tables.filter((t) => !tableExists(url, t));
  if (missing.length > 0) {
    return { name: "row_counts", passed: false, detail: `missing tables: ${missing.join(", ")}` };
  }
  if (tableExists(url, "backup_manifest")) {
    const rows = psql(url, [
      "-c",
      `SELECT table_name, expected_rows FROM backup_manifest`,
    ]);
    const problems: string[] = [];
    for (const line of rows.split("\n").filter(Boolean)) {
      const [table, expectedRaw] = line.split("|");
      const expected = Number(expectedRaw);
      const actual = Number(queryScalar(url, `SELECT count(*) FROM "${table}"`));
      const drift = expected === 0 ? (actual === 0 ? 0 : 1) : Math.abs(actual - expected) / expected;
      if (drift > tolerance) {
        problems.push(`${table}: expected ${expected}, got ${actual} (drift ${(drift * 100).toFixed(2)}%)`);
      }
    }
    return problems.length === 0
      ? { name: "row_counts", passed: true, detail: "all tables within tolerance" }
      : { name: "row_counts", passed: false, detail: problems.join("; ") };
  }
  const empty = tables.filter((t) => queryScalar(url, `SELECT count(*) FROM "${t}"`) === "0");
  return empty.length === 0
    ? { name: "row_counts", passed: true, detail: "no manifest; all tables non-empty" }
    : { name: "row_counts", passed: false, detail: `empty tables: ${empty.join(", ")}` };
}

function checkEvidenceChain(url: string): CheckResult {
  if (!tableExists(url, "oracle_evidence")) {
    return { name: "evidence_chain", passed: false, detail: "oracle_evidence table missing" };
  }
  // Gap-free sequence: no missing seq numbers within each feed.
  const gaps = psql(url, [
    "-c",
    `SELECT feed_id, count(*) FROM (
       SELECT feed_id, seq,
              lag(seq) OVER (PARTITION BY feed_id ORDER BY seq) AS prev
       FROM oracle_evidence
     ) g WHERE prev IS NOT NULL AND seq <> prev + 1
     GROUP BY feed_id`,
  ]);
  if (gaps) {
    return { name: "evidence_chain", passed: false, detail: `sequence gaps: ${gaps}` };
  }
  // Hash continuity: each row's prev_hash must equal the previous row's hash.
  const broken = psql(url, [
    "-c",
    `SELECT feed_id, seq FROM (
       SELECT feed_id, seq, prev_hash,
              lag(hash) OVER (PARTITION BY feed_id ORDER BY seq) AS expected_prev
       FROM oracle_evidence
     ) c WHERE expected_prev IS NOT NULL AND prev_hash IS DISTINCT FROM expected_prev
     LIMIT 10`,
  ]);
  if (broken) {
    return { name: "evidence_chain", passed: false, detail: `hash chain broken at: ${broken}` };
  }
  return { name: "evidence_chain", passed: true, detail: "gap-free and hash-continuous" };
}

function checkReferential(url: string): CheckResult {
  if (!tableExists(url, "claims")) {
    return { name: "referential", passed: false, detail: "claims table missing" };
  }
  const orphanClaims = psql(url, [
    "-c",
    `SELECT c.id FROM claims c
     WHERE c.status = 'settled'
       AND NOT EXISTS (SELECT 1 FROM consensus_decisions d WHERE d.claim_id = c.id)
     LIMIT 10`,
  ]);
  if (orphanClaims) {
    return { name: "referential", passed: false, detail: `settled claims without decision: ${orphanClaims}` };
  }
  const orphanEvidence = psql(url, [
    "-c",
    `SELECT c.id FROM claims c
     WHERE c.status = 'settled'
       AND NOT EXISTS (SELECT 1 FROM oracle_evidence e WHERE e.claim_id = c.id)
     LIMIT 10`,
  ]);
  if (orphanEvidence) {
    return { name: "referential", passed: false, detail: `settled claims without evidence: ${orphanEvidence}` };
  }
  return { name: "referential", passed: true, detail: "every settled claim has decision + evidence" };
}

function emitReport(cfg: DrillConfig, report: DrillReport): void {
  fs.mkdirSync(path.dirname(cfg.reportPath), { recursive: true });
  fs.writeFileSync(cfg.reportPath, JSON.stringify(report, null, 2) + "\n");
  if (cfg.metricsUrl) {
    try {
      execFileSync(
        "curl",
        ["-fsS", "-X", "POST", "-H", "Content-Type: application/json", "--data-binary", "@-", cfg.metricsUrl],
        { input: JSON.stringify(report), encoding: "utf8" }
      );
    } catch (err) {
      // Metrics emission must never mask the drill outcome.
      console.error(`warning: failed to POST drill report to metrics endpoint: ${(err as Error).message}`);
    }
  }
}

function teardown(cfg: DrillConfig): void {
  if (cfg.keep) return;
  try {
    psql(adminUrl(cfg.targetUrl), ["-c", `DROP DATABASE IF EXISTS "${cfg.dbName}"`]);
  } catch (err) {
    console.error(`warning: teardown failed: ${(err as Error).message}`);
  }
}

export function runRestoreDrill(): DrillReport {
  const cfg = loadDrillConfig();
  const startedAt = new Date();
  const diagnostics: string[] = [];
  const checks: CheckResult[] = [];
  let restoreDurationSeconds = 0;

  const dataLossWindowSeconds = Math.max(
    0,
    Math.round((startedAt.getTime() - cfg.backupTakenAt.getTime()) / 1000)
  );

  try {
    provisionDatabase(cfg);
    applyMigrations(cfg);
    const restoreStart = Date.now();
    restoreBackup(cfg);
    restoreDurationSeconds = Math.round((Date.now() - restoreStart) / 1000);

    const target = withDatabase(cfg.targetUrl, cfg.dbName);
    checks.push(checkRowCounts(target, cfg.rowTolerance));
    checks.push(checkEvidenceChain(target));
    checks.push(checkReferential(target));
  } catch (err) {
    diagnostics.push((err as Error).message);
  } finally {
    teardown(cfg);
  }

  // Fail closed if the backup is older than the RPO target.
  if (dataLossWindowSeconds > cfg.rpoTargetSeconds) {
    checks.push({
      name: "rpo",
      passed: false,
      detail: `backup age ${dataLossWindowSeconds}s exceeds RPO target ${cfg.rpoTargetSeconds}s`,
    });
  } else {
    checks.push({
      name: "rpo",
      passed: true,
      detail: `backup age ${dataLossWindowSeconds}s within RPO target ${cfg.rpoTargetSeconds}s`,
    });
  }

  const passed = diagnostics.length === 0 && checks.every((c) => c.passed);
  const report: DrillReport = {
    status: passed ? "pass" : "fail",
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    restoreDurationSeconds,
    dataLossWindowSeconds,
    rpoTargetSeconds: cfg.rpoTargetSeconds,
    backupTakenAt: cfg.backupTakenAt.toISOString(),
    checks,
    diagnostics,
  };
  emitReport(cfg, report);
  return report;
}

if (require.main === module && process.argv.includes("--restore-drill")) {
  const report = runRestoreDrill();
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.status === "pass" ? 0 : 1);
}

const header =
  "// Golden XDR fixtures for hand-built ScVal encodings.\n" +
  "// Regenerated by: npx ts-node scripts/regenerate-xdr-fixtures.ts\n" +
  "// A mismatch means either the contract ABI changed or the encoding regressed —\n" +
  "// check both before regenerating.\n";

function writeB64(name: string, scVal: xdr.ScVal, note?: string): void {
  const body = header + (note ? `// ${note}\n` : "") + scVal.toXDR("base64") + "\n";
  fs.writeFileSync(path.join(outDir, name), body);
}

fs.mkdirSync(outDir, { recursive: true });

const amounts = [
  10_000n * 10_000_000n,
  25_000n * 10_000_000n,
  50_000n * 10_000_000n,
  2n ** 60n,
  1_000n * 10_000_000n,
];
const days = [30, 90, 180, 365, 7];

for (let i = 0; i < COVERAGE_TYPE_VARIANTS.length; i++) {
  const sc = buildPolicyParamsScVal({
    coverageType: i,
    coverageAmount: amounts[i],
    durationDays: days[i],
    triggerThreshold: TRIGGER_THRESHOLDS[i],
  });
  writeB64(
    `policy-params-${COVERAGE_TYPE_VARIANTS[i]}.xdr.b64`,
    sc,
    `coverageType=${i} amount=${amounts[i]} days=${days[i]} threshold=${TRIGGER_THRESHOLDS[i]}`
  );
}

writeB64(
  "policy-params-large-i128.xdr.b64",
  buildPolicyParamsScVal({
    coverageType: 0,
    coverageAmount: 2n ** 60n,
    durationDays: 30,
    triggerThreshold: 500,
  }),
  "amount=2^60"
);

writeB64("process-claim-u64.xdr.b64", encodeProcessClaimArg(42n));

const seed = Buffer.alloc(32, 7);
const kp = Keypair.fromRawEd25519Seed(seed);
const [providerSc, amountSc] = encodeProvideCapitalArgs(kp.publicKey(), 10_000_000_000n);
const [, sharesSc] = encodeWithdrawCapitalArgs(kp.publicKey(), 5_000_000_000n);
writeB64("provide-capital-provider.xdr.b64", providerSc);
writeB64("provide-capital-amount.xdr.b64", amountSc);
writeB64("withdraw-capital-shares.xdr.b64", sharesSc);
fs.writeFileSync(
  path.join(outDir, "provide-capital-meta.json"),
  JSON.stringify({ providerPubkey: kp.publicKey(), amount: "10000000000", shares: "5000000000" }, null, 2) + "\n"
);

const [feed, value, ts] = encodeOraclePublishArgs("USDC_USD", 9_500_000n, 1_700_000_000n);
writeB64("oracle-publish-feed.xdr.b64", feed);
writeB64("oracle-publish-value.xdr.b64", value);
writeB64("oracle-publish-timestamp.xdr.b64", ts);

// silence unused import if tree-shaken oddly
void Address;
void nativeToScVal;

console.log(`Regenerated fixtures in ${outDir}`);

// ---------------------------------------------------------------------------
// Reference data importer (issue #287)
// ---------------------------------------------------------------------------
// Loads a reference dataset (airports, routes, carriers, protocols, markets,
// chains, assets) from a JSON or CSV source, validates it, and publishes it as
// a new immutable dataset version. Published versions are never mutated: any
// attempt to write to an already-published version fails.
//
// Usage:
//   npx ts-node scripts/import-reference-data.ts --file data/airports.json \
//     --kind airports --version 2024.11.1 --effective-from 2024-11-01T00:00:00Z \
//     [--effective-to 2025-11-01T00:00:00Z] [--dry-run]
//
// --dry-run prints a diff (added / changed / retired entities and ambiguous
// alias mappings) against the currently pinned version without writing.
//
// This block is intentionally self-contained so the fixture regeneration above
// keeps working unchanged; the importer is only executed when this file is run
// with an --file argument.

import {
  ReferenceDataRepository,
  ReferenceDatasetKind,
  ReferenceEntityInput,
  ReferenceAliasInput,
  validateReferenceDataset,
  diffReferenceDatasets,
  formatReferenceDiff,
} from "../src/oracle/referenceData";

interface ImportArgs {
  file: string;
  kind: ReferenceDatasetKind;
  version: string;
  effectiveFrom: string;
  effectiveTo?: string;
  dryRun: boolean;
  baseVersion?: string;
}

function parseArgs(argv: string[]): ImportArgs {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const file = get("--file");
  const kind = get("--kind") as ReferenceDatasetKind | undefined;
  const version = get("--version");
  const effectiveFrom = get("--effective-from");
  if (!file || !kind || !version || !effectiveFrom) {
    throw new Error(
      "Usage: import-reference-data --file <path> --kind <kind> --version <ver> --effective-from <iso> [--effective-to <iso>] [--dry-run]"
    );
  }
  return {
    file,
    kind,
    version,
    effectiveFrom,
    effectiveTo: get("--effective-to"),
    dryRun: argv.includes("--dry-run"),
    baseVersion: get("--base-version"),
  };
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",").map((c) => c.trim());
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

function loadSource(file: string): { entities: ReferenceEntityInput[]; aliases: ReferenceAliasInput[] } {
  const raw = fs.readFileSync(file, "utf8");
  const isCsv = file.toLowerCase().endsWith(".csv");
  const parsed = isCsv ? parseCsv(raw) : JSON.parse(raw);
  const entities: ReferenceEntityInput[] = Array.isArray(parsed) ? parsed : parsed.entities ?? [];
  const aliases: ReferenceAliasInput[] = Array.isArray(parsed) ? [] : parsed.aliases ?? [];
  return { entities, aliases };
}

async function runImporter(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const { entities, aliases } = loadSource(args.file);

  const validation = validateReferenceDataset({ kind: args.kind, entities, aliases });
  if (!validation.ok) {
    console.error("Reference dataset failed validation:");
    for (const err of validation.errors) console.error(`  - ${err}`);
    process.exitCode = 1;
    return;
  }

  const repo = new ReferenceDataRepository();
  const baseVersion = args.baseVersion ?? (await repo.getPinnedVersion(args.kind));

  if (args.dryRun) {
    const base = baseVersion ? await repo.getDataset(args.kind, baseVersion) : null;
    const diff = diffReferenceDatasets(base, { kind: args.kind, entities, aliases });
    console.log(formatReferenceDiff(diff));
    return;
  }

  if (baseVersion && (await repo.isPublished(args.kind, args.version))) {
    throw new Error(
      `Dataset ${args.kind}@${args.version} is already published and immutable; bump --version instead of mutating it.`
    );
  }

  await repo.publishDataset({
    kind: args.kind,
    version: args.version,
    effectiveFrom: args.effectiveFrom,
    effectiveTo: args.effectiveTo,
    entities,
    aliases,
  });
  console.log(`Published ${args.kind}@${args.version} (${entities.length} entities, ${aliases.length} aliases).`);
}

if (require.main === module && process.argv.includes("--file")) {
  runImporter(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
