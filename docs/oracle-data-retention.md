# Oracle data retention, archival, and restore

## Retention matrix

| Data class | Storage | Retention window | Dropped by retention job? | Notes |
| --- | --- | --- | --- | --- |
| Raw oracle readings (`oracle_events`) | Monthly range partitions (`oracle_events_YYYY_MM`) | `DB_ORACLE_RETENTION_MONTHS` (default 6) | Yes, only after a verified archive exists and no open dispute pin | Archived to `oracle_events_YYYY_MM.jsonl.gz` before drop |
| Corroboration inputs and probe results | Not persisted in this repo yet | n/a | n/a | When added, partition by time with the same pattern and add to this matrix |
| Decisions (trigger / claim outcomes) | Not persisted in this repo yet | n/a | n/a | Must be stored with either an inlined input snapshot or stable reading ids, see below |
| Evidence ledger | Not present in this repo yet | n/a | n/a | Append-only. The retention job must never update or delete it |
| Idempotency keys (`idempotency_keys`) | Plain table | 24 hours | Yes (`purgeStaleIdempotencyKeys`) | Clients are not expected to retry a write after 24 hours |

## Lifecycle

1. **Partition maintenance** (`OracleRetentionService.ensureUpcomingPartitions`, daily 01:00 UTC) creates the current and next two monthly partitions.
2. **Archive** (`scripts/archive-oracle-partitions.ts`, run by an operator or scheduler) exports every closed partition older than the cutoff. It writes a gzip'd JSONL artifact, re-reads it, and records a `verified` row in `oracle_partition_archives`.
3. **Drop** (`OracleRetentionService.pruneOldPartitions`, daily 02:00 UTC) drops a partition only if:
   - it is older than the retention window,
   - it has a `verified` row in `oracle_partition_archives`, and
   - it has no open pin in `oracle_partition_pins` (`released_at IS NULL`).

   Any other partition is logged and kept. Nothing is dropped without an archive.

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
- Timestamps are rendered in UTC. The gzip header has no timestamp, so the same partition exports to the same bytes.
- Integrity: SHA-256 of the artifact file, row count, and parse check of every line. Both values are stored in `oracle_partition_archives`.
- Signing is not implemented. If required, sign the `sha256` column with an operator key and store the signature alongside the manifest.

## Running the archive job

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

1. Confirm the artifact against its manifest. This checks the checksum and row count:

   ```sh
   npx ts-node scripts/archive-oracle-partitions.ts --verify /var/archives/oracle/oracle_events_2026_01.jsonl.gz
   ```

2. Restore into a scratch database. Do not restore into production `oracle_events` unless the partition has been detached:

   ```sh
   createdb refract_restore
   psql refract_restore -f src/db/schema.sql
   psql refract_restore -f src/db/migrations/001_idempotency_and_oracle_partitioning.sql
   ```

3. Load the rows. `oracle_events` is partitioned by `recorded_at`, so the partition for the archived month is created by the scratch schema's range rules (`ensureUpcomingPartitions` creates it for current and future months; create the archived month manually if it is missing). Stage the JSONL as text, then insert:

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

4. Compare the restored row count with the manifest:

   ```sql
   SELECT COUNT(*) FROM oracle_events WHERE recorded_at >= '2026-01-01' AND recorded_at < '2026-02-01';
   ```

   The result must equal `row_count` in `oracle_partition_archives`.

5. Once the restore is confirmed, drop the scratch database. Production partitions are not changed by the restore.

## Migration notes

- `src/db/migrations/004_oracle_partition_archive_lifecycle.sql` creates two new tables and takes no lock on `oracle_events`.
- Deploying the retention change without running the archive job first means partitions older than the window are kept and logged as "no verified archive". This is intended. Run the archive job, then the drop cron will proceed.
