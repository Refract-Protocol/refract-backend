/**
 * Archives aged oracle_events partitions to a gzip'd JSONL artifact with a
 * SHA-256 checksum, then re-reads the artifact and checks it against the
 * database before recording it as 'verified' in oracle_partition_archives.
 * OracleRetentionService only drops a partition once it is verified and not
 * pinned by an open dispute.
 *
 * Archive closed months (dry-run first):
 *   DATABASE_URL=... npx ts-node scripts/archive-oracle-partitions.ts --out ./archives --dry-run
 *   DATABASE_URL=... npx ts-node scripts/archive-oracle-partitions.ts --out ./archives
 *
 * Verify a previously written artifact against its manifest row:
 *   DATABASE_URL=... npx ts-node scripts/archive-oracle-partitions.ts --verify ./archives/oracle_events_2026_01.jsonl.gz
 *
 * Options:
 *   --out <dir>      Directory for artifacts (required unless --verify)
 *   --cutoff YYYY-MM Archive partitions strictly older than this month
 *                    (default: current UTC month minus DB_ORACLE_RETENTION_MONTHS, default 6)
 *   --dry-run        Print the plan without writing files or manifest rows
 *   --verify <file>  Check an artifact's checksum and row count against the manifest
 *
 * Idempotent and resumable: verified partitions are skipped. Artifacts are
 * written to a .tmp file and renamed only after streaming completes, and the
 * manifest row is written last. A crash mid-run leaves at most an unrecorded
 * artifact, which the next run overwrites.
 *
 * Export is deterministic: rows are ordered by (recorded_at, id), the session
 * time zone is pinned to UTC, and gzip writes no timestamp in its header, so
 * the same partition always produces the same bytes.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import * as zlib from "zlib";
import { Pool, PoolClient } from "pg";

const PARTITION_PATTERN = /^oracle_events_(\d{4})_(\d{2})$/;
const BATCH_SIZE = 5000;

interface Partition {
  name: string;
  /** Year * 12 + zero-based month, so comparisons don't depend on time zone. */
  ym: number;
}

interface Args {
  out?: string;
  cutoff?: string;
  dryRun: boolean;
  verify?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--out") args.out = argv[++i];
    else if (flag === "--cutoff") args.cutoff = argv[++i];
    else if (flag === "--verify") args.verify = argv[++i];
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!args.verify && !args.out) throw new Error("--out <dir> is required");
  return args;
}

function toYm(year: number, month: number): number {
  return year * 12 + (month - 1);
}

function parseCutoff(value: string | undefined): number {
  if (value) {
    const match = /^(\d{4})-(\d{2})$/.exec(value);
    if (!match) throw new Error(`--cutoff must be YYYY-MM, got "${value}"`);
    return toYm(parseInt(match[1], 10), parseInt(match[2], 10));
  }
  const retentionMonths = parseInt(process.env.DB_ORACLE_RETENTION_MONTHS ?? "6", 10);
  const now = new Date();
  return toYm(now.getUTCFullYear(), now.getUTCMonth() + 1) - retentionMonths;
}

async function listPartitions(pool: Pool): Promise<Partition[]> {
  const { rows } = await pool.query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_inherits i
       JOIN pg_class c  ON c.oid = i.inhrelid
       JOIN pg_class p  ON p.oid = i.inhparent
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE p.relname = 'oracle_events' AND n.nspname = 'public'
      ORDER BY c.relname`
  );
  const partitions: Partition[] = [];
  for (const row of rows) {
    const match = PARTITION_PATTERN.exec(row.relname);
    if (!match) continue;
    partitions.push({ name: row.relname, ym: toYm(parseInt(match[1], 10), parseInt(match[2], 10)) });
  }
  return partitions;
}

/** Streams the partition as JSONL in a fixed order, one row per line. */
async function* jsonlLines(client: PoolClient, name: string, counter: { rows: number }): AsyncGenerator<string> {
  let last: { recorded_at: string; id: string } | null = null;
  for (;;) {
    const params: unknown[] = [BATCH_SIZE];
    let where = "";
    if (last) {
      where = "WHERE (recorded_at, id) > ($2::timestamptz, $3::bigint)";
      params.push(last.recorded_at, last.id);
    }
    const { rows } = await client.query<{ line: string; recorded_at: string; id: string }>(
      `SELECT row_to_json(p)::text AS line, p.recorded_at::text AS recorded_at, p.id::text AS id
         FROM (SELECT id, coverage_type, value, source, severity, recorded_at
                 FROM ${name} ${where}
                ORDER BY recorded_at, id
                LIMIT $1) p
        ORDER BY p.recorded_at, p.id`,
      params
    );
    for (const row of rows) {
      counter.rows++;
      yield `${row.line}\n`;
    }
    if (rows.length < BATCH_SIZE) return;
    const tail = rows[rows.length - 1];
    last = { recorded_at: tail.recorded_at, id: tail.id };
  }
}

async function writeArtifact(pool: Pool, name: string, finalPath: string): Promise<number> {
  const tmpPath = `${finalPath}.tmp`;
  const counter = { rows: 0 };
  const client = await pool.connect();
  try {
    // Pin the session time zone so row_to_json timestamps are identical across runs.
    await client.query("SET TIME ZONE 'UTC'");
    await pipeline(
      Readable.from(jsonlLines(client, name, counter)),
      zlib.createGzip(),
      fs.createWriteStream(tmpPath)
    );
  } finally {
    client.release();
  }
  fs.renameSync(tmpPath, finalPath);
  return counter.rows;
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** Decompresses the artifact and checks every line is a JSON object with an id. */
async function countArtifactRows(file: string): Promise<number> {
  const lines = readline.createInterface({
    input: fs.createReadStream(file).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  let rows = 0;
  for await (const line of lines) {
    const parsed = JSON.parse(line) as { id?: unknown; recorded_at?: unknown };
    if (parsed.id === undefined || parsed.recorded_at === undefined) {
      throw new Error(`Malformed row ${rows + 1} in ${file}`);
    }
    rows++;
  }
  return rows;
}

async function verifyAgainstDb(pool: Pool, file: string): Promise<void> {
  const name = path.basename(file).replace(/\.jsonl\.gz$/, "");
  const { rows: manifest } = await pool.query<{ row_count: string; sha256: string }>(
    `SELECT row_count, sha256 FROM oracle_partition_archives WHERE partition_name = $1`,
    [name]
  );
  if (manifest.length === 0) throw new Error(`No manifest row for ${name}`);

  const sha = await sha256File(file);
  if (sha !== manifest[0].sha256.trim()) throw new Error(`Checksum mismatch for ${file}`);

  const rows = await countArtifactRows(file);
  if (rows !== Number(manifest[0].row_count)) {
    throw new Error(`Row count mismatch for ${file}: manifest ${manifest[0].row_count}, artifact ${rows}`);
  }
}

async function archivePartition(pool: Pool, part: Partition, outDir: string): Promise<void> {
  const finalPath = path.join(outDir, `${part.name}.jsonl.gz`);
  const expectedRows = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${part.name}`);

  const writtenRows = await writeArtifact(pool, part.name, finalPath);
  const sha = await sha256File(finalPath);
  const artifactRows = await countArtifactRows(finalPath);

  const sourceRows = Number(expectedRows.rows[0].count);
  if (writtenRows !== sourceRows || artifactRows !== sourceRows) {
    fs.rmSync(finalPath, { force: true });
    throw new Error(
      `Row mismatch for ${part.name}: source ${sourceRows}, exported ${writtenRows}, re-read ${artifactRows}`
    );
  }

  await pool.query(
    `INSERT INTO oracle_partition_archives (partition_name, row_count, sha256, archive_path, status, verified_at)
     VALUES ($1, $2, $3, $4, 'verified', NOW())
     ON CONFLICT (partition_name) DO UPDATE
       SET row_count = EXCLUDED.row_count,
           sha256 = EXCLUDED.sha256,
           archive_path = EXCLUDED.archive_path,
           status = 'verified',
           archived_at = NOW(),
           verified_at = NOW()`,
    [part.name, artifactRows, sha, path.resolve(finalPath)]
  );
  console.log(`archived ${part.name}: ${artifactRows} rows, sha256=${sha}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    if (args.verify) {
      await verifyAgainstDb(pool, args.verify);
      console.log(`verified ${args.verify}`);
      return;
    }

    const outDir = args.out!;
    const cutoff = parseCutoff(args.cutoff);
    const now = new Date();
    const currentYm = toYm(now.getUTCFullYear(), now.getUTCMonth() + 1);
    if (cutoff >= currentYm) throw new Error("--cutoff must be before the current UTC month");

    const { rows: archived } = await pool.query<{ partition_name: string }>(
      `SELECT partition_name FROM oracle_partition_archives WHERE status = 'verified'`
    );
    const verified = new Set(archived.map((r) => r.partition_name));

    const eligible = (await listPartitions(pool)).filter((p) => p.ym < cutoff);
    if (args.dryRun) {
      for (const part of eligible) {
        const action = verified.has(part.name) ? "skip (already verified)" : "would archive";
        console.log(`[dry-run] ${part.name}: ${action}`);
      }
      return;
    }

    fs.mkdirSync(outDir, { recursive: true });
    for (const part of eligible) {
      if (verified.has(part.name)) {
        console.log(`skip ${part.name}: already verified`);
        continue;
      }
      await archivePartition(pool, part, outDir);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
