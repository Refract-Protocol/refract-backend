# Oracle data retention, archival, and restore

Old raw oracle readings are archived to files, not deleted. A partition leaves the live database only after a verified archive of it exists.

## Retention matrix

| Data class | Storage | Retention window | Dropped by retention job? | Notes |
| --- | --- | --- | --- | --- |
| Raw oracle readings (`oracle_events`) | Monthly range partitions (`oracle_events_YYYY_MM`) | `DB_ORACLE_RETENTION_MONTHS` (default 6) | Yes, only after a verified archive exists and no open dispute pin | Archived to `oracle_events_YYYY_MM.jsonl.gz` before drop |
| Corroboration inputs and probe results | Not persisted in this repo yet | n/a | n/a | When added, partition by time with the same pattern and add to this matrix |
| Decisions (trigger / claim outcomes) | Not persisted in this repo yet | n/a | n/a | Must be stored with either an inlined input snapshot or stable reading ids, see below |
| Evidence ledger | Not present in this repo yet | n/a | n/a | Append-only. The retention job must never update or delete it |
| Idempotency keys (`idempotency_keys`) | Plain table | 24 hours | Yes (`purgeStaleIdempotencyKeys`) | Clients are not expected to retry a write after 24 hours |

## Retention window

- **Setting:** `DB_ORACLE_RETENTION_MONTHS`, default `6`. It is read directly from `process.env` in two places that must agree: `OracleRetentionService` (`src/oracle/oracle-retention.service.ts`) and `scripts/archive-oracle-partitions.ts`. It is not in `src/config/env.schema.ts`, so it is not validated.
- **Meaning:** a partition is eligible when its month is strictly older than the current UTC month minus the window.
- **Failure mode:** a non-numeric value makes the cutoff `NaN`. The archive script then archives nothing and exits 0, and the drop job drops nothing. Nothing is lost, but retention silently stops. Check the value after any deploy.
- `--cutoff YYYY-MM` on the archive script overrides the window for that run only. The drop job has no override.

## Lifecycle

1. **Partition maintenance** (`OracleRetentionService.ensureUpcomingPartitions`, `@Cron("0 1 * * *")`, also run at app bootstrap) creates the current and next two monthly partitions.
2. **Archive** (`scripts/archive-oracle-partitions.ts`, run by an operator or scheduler; nothing in this repo schedules it) exports every closed partition older than the cutoff to `<out>/oracle_events_YYYY_MM.jsonl.gz`. It re-reads the file, checks it, and then writes a `verified` row to `oracle_partition_archives`. The row holds the absolute path, SHA-256, and row count.
3. **Drop** (`OracleRetentionService.pruneOldPartitions`, `@Cron("0 2 * * *")`) runs `DROP TABLE` on a partition only if all three hold:
   - it is older than the retention window,
   - it has a `verified` row in `oracle_partition_archives`, and
   - it has no open pin in `oracle_partition_pins` (`released_at IS NULL`).

   Any other partition is logged and kept. Nothing is dropped without an archive. The drop job never deletes an archive file or a manifest row.

**Schedule time zone:** the `@Cron` decorators set no `timeZone`, so the jobs run at the server's local time, not UTC. They are UTC only if the host clock is UTC. The drop job's month cutoff also uses local time, while the archive script uses UTC. A mismatch can only delay drops, because the drop job still requires a verified archive.

## Where archives go and how long they are kept

- **Location:** the directory passed to `--out`. There is no default and no storage config in this repo. The manifest records the absolute path, but `--verify` checks whatever file you pass it and does not compare the path.
- **Not deleted by this repo:** no job here deletes an archive file or an `oracle_partition_archives` row.
- **Duration:** not defined here. There is no expiry in code, so how long archives are kept is an operator policy. Once a partition is dropped, its archive is the only copy of those readings. Keep archives for at least as long as the disputes they support, and back them up.

### Dispute pins

A dispute that references readings in a partition must pin that partition:

```sql
INSERT INTO oracle_partition_pins (partition_name, reason)
VALUES ('oracle_events_2026_01', 'dispute #<id>');
```

Release the pin after the dispute window has elapsed:

```sql
UPDATE oracle_partition_pins SET released_at = NOW()
 WHERE partition_name = 'oracle_events_2026_01' AND released_at IS NULL;
```

### Decision input preservation (for future decision tables)

When a decision is stored, it must be reproducible after raw readings expire. Choose one of:

- **Inline snapshot:** store the exact input readings in the decision row (`JSONB`).
- **Stable reading ids:** store the `(id, recorded_at)` of each input reading. The partition holding them must stay pinned until the decision's dispute window closes.

## Archive artifact format

- File: `<out>/oracle_events_YYYY_MM.jsonl.gz`
- One JSON object per line, with keys `id, coverage_type, value, source, severity, recorded_at`, ordered by `(recorded_at, id)`.
- **Only those six columns are exported.** Columns added by later migrations are not in the artifact: `seq`, `kind`, `payload`, `ingested_at`, `observed_at`, `payload_digest`, `usable`, `rejection_reason`, and `replayed_from_dead_letter_id`. The artifact is a reading export, not a full row dump.
- Timestamps are rendered in UTC. The gzip header has no timestamp, so the same partition exports to the same bytes.
- Integrity: SHA-256 of the artifact file, row count, and a parse check on every line, which only confirms each line is JSON with `id` and `recorded_at`. Both values are stored in `oracle_partition_archives`.
- Signing is not implemented. If required, sign the `sha256` column with an operator key and store the signature alongside the manifest.

## Running the archive job

`DATABASE_URL` is required for every mode, including `--verify`, because the script reads the manifest from that database.

Dry run (no files written, no manifest rows):

```sh
DATABASE_URL=postgresql://... npx ts-node scripts/archive-oracle-partitions.ts --out ./archives --dry-run
```

Archive partitions older than the retention window:

```sh
DATABASE_URL=postgresql://... npx ts-node scripts/archive-oracle-partitions.ts --out /var/archives/oracle
```

Archive partitions older than a specific month:

```sh
DATABASE_URL=postgresql://... npx ts-node scripts/archive-oracle-partitions.ts --out ./archives --cutoff 2026-04
```

The job is idempotent: verified partitions are skipped, so re-running after a crash resumes where it stopped. The job never archives the current UTC month.

Verify an artifact against its manifest row:

```sh
DATABASE_URL=postgresql://... npx ts-node scripts/archive-oracle-partitions.ts --verify ./archives/oracle_events_2026_01.jsonl.gz
```

## Restore runbook

Restores go to a scratch database. Production `oracle_events` is not changed by this procedure.

1. Confirm the artifact against its manifest row. This checks the checksum and row count. Run it against the database that holds the manifest, which is production or a copy of it:

   ```sh
   DATABASE_URL=postgresql://... npx ts-node scripts/archive-oracle-partitions.ts --verify /var/archives/oracle/oracle_events_2026_01.jsonl.gz
   ```

2. Create a scratch database with an `oracle_events` table that has at least the six exported columns. The partitioned schema is not in this checkout: `src/db/schema.sql` and `src/db/migrations/001_idempotency_and_oracle_partitioning.sql` are empty files. The table itself comes from the node-pg-migrate baseline (`migrations/1748476800000_baseline-schema.ts`), which defines a plain, unpartitioned `oracle_events` with those six columns. I have not run this path, so confirm it creates a usable table before relying on it:

   ```sh
   createdb refract_restore
   DATABASE_URL=postgresql://.../refract_restore npm run migrate:up
   ```

3. Load the rows. Stage the JSONL as text, then insert the six columns. The other columns take their defaults, and the archive does not carry them (see the format section):

   ```sh
   zcat /var/archives/oracle/oracle_events_2026_01.jsonl.gz > /tmp/oracle_events_2026_01.jsonl
   psql refract_restore <<'SQL'
   CREATE TEMP TABLE staged (line TEXT);
   \copy staged (line) FROM '/tmp/oracle_events_2026_01.jsonl'
   INSERT INTO oracle_events (id, coverage_type, value, source, severity, recorded_at)
   SELECT j.id, j.coverage_type::coverage_type, j.value, j.source, j.severity, j.recorded_at
     FROM staged s,
          LATERAL jsonb_to_record(s.line::jsonb)
            AS j(id BIGINT, coverage_type TEXT, value NUMERIC, source TEXT, severity TEXT, recorded_at TIMESTAMPTZ);
   SQL
   ```

   **Fidelity limit:** the restored rows lack the evidence fields listed above, so `seq` and `payload` are lost and the evidence chain cannot be rebuilt from this restore. Rejected readings also come back `usable = true`, because `usable` is not in the artifact and takes its default. Treat the restore as a restore of readings only, and do not use it to answer questions that depend on rejection status.

4. Compare the restored row count with the manifest, on the scratch database:

   ```sql
   SELECT COUNT(*) FROM oracle_events WHERE recorded_at >= '2026-01-01' AND recorded_at < '2026-02-01';
   ```

   The result must equal `row_count` in `oracle_partition_archives`.

5. Once the restore is confirmed, drop the scratch database.

## Migration notes

- `src/db/migrations/004_oracle_partition_archive_lifecycle.sql` creates two new tables and takes no lock on `oracle_events`. It assumes the partitioned `oracle_events` from `001_idempotency_and_oracle_partitioning.sql`, which is empty in this checkout.
- Deploying the retention change without running the archive job first means partitions older than the window are kept and logged as "no verified archive". This is intended. Run the archive job, then the drop cron will proceed.
