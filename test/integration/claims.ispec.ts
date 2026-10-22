import { Pool } from "pg";
import { createTestPool, truncateTables } from "./setup/db-client";

/**
 * Integration tests for the versioned reference data registry and
 * ingestion-time entity validation.
 *
 * Covers:
 *  - seeding a versioned dataset with aliases and a retired entity
 *  - unknown / retired / ambiguous entities being routed to the dead-letter
 *    path with a reason and never counted toward quorum or consensus
 *  - a valid aliased entity resolving to its canonical ID and being accepted
 *  - dataset version pinning (a past reading is interpreted against the
 *    version it was ingested under)
 */

/**
 * Integration tests for the `claims` table.
 *
 * Covers:
 *  - INSERT with a valid policy FK and SELECT round-trip
 *  - NUMERIC(20,6) trigger_value precision
 *  - FK constraint: inserting a claim for a non-existent policy_id fails
 *  - Cascading DELETE: removing a policy removes its claims
 *  - holder index path (idx_claims_holder)
 */

describe("claims table", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createTestPool();
  });

  afterAll(() => pool.end());

  beforeEach(() => truncateTables(pool, ["claims", "premium_revenue", "policies"]));

  // ── helpers ────────────────────────────────────────────────────────────

  const HOLDER = "GCKFBEIYTKP6RSBULG6SNDJ3DHMFAZRXSVXFBKIPZXKQHDQIQTEXAMPLE";

  async function insertPolicy(policyId = "POL-001"): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO policies
         (policy_id, holder, coverage_type, coverage_amount, premium,
          duration_days, expires_at, trigger_params, is_active)
       VALUES ($1,$2,'stablecoin_depeg','1000000','50000',30,$3,'{}',true)
       RETURNING id`,
      [policyId, HOLDER, new Date(Date.now() + 30 * 86400 * 1000).toISOString()]
    );
    return rows[0].id;
  }

  async function insertClaim(policyUuid: string, overrides: Record<string, unknown> = {}) {
    const defaults = {
      policy_id: policyUuid,
      holder: HOLDER,
      coverage_type: "stablecoin_depeg",
      payout: "1000000",
      trigger_value: "0.942000",
      trigger_source: "coingecko",
      tx_hash: "abc123",
    };
    const row = { ...defaults, ...overrides };
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO claims
         (policy_id, holder, coverage_type, payout, trigger_value, trigger_source, tx_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [
        row.policy_id,
        row.holder,
        row.coverage_type,
        row.payout,
        row.trigger_value,
        row.trigger_source,
        row.tx_hash,
      ]
    );
    return rows[0].id;
  }

  // ── tests ──────────────────────────────────────────────────────────────

  it("inserts and retrieves a claim row", async () => {
    const policyUuid = await insertPolicy();
    const claimId = await insertClaim(policyUuid);

    const { rows } = await pool.query(`SELECT * FROM claims WHERE id = $1`, [claimId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].holder).toBe(HOLDER);
    expect(rows[0].coverage_type).toBe("stablecoin_depeg");
    expect(rows[0].tx_hash).toBe("abc123");
  });

  it("round-trips NUMERIC(20,6) trigger_value with full precision", async () => {
    const policyUuid = await insertPolicy();
    await insertClaim(policyUuid, { trigger_value: "0.942137" });

    const { rows } = await pool.query(`SELECT trigger_value::text FROM claims WHERE policy_id = $1`, [policyUuid]);
    expect(rows[0].trigger_value).toBe("0.942137");
  });

  it("rejects a claim referencing a non-existent policy (FK constraint)", async () => {
    const fakeUuid = "00000000-0000-0000-0000-000000000000";
    await expect(insertClaim(fakeUuid)).rejects.toThrow(/foreign key/i);
  });

  it("cascades DELETE: removing a policy removes its claims", async () => {
    const policyUuid = await insertPolicy();
    const claimId = await insertClaim(policyUuid);

    // Verify claim exists before deletion
    const before = await pool.query(`SELECT id FROM claims WHERE id = $1`, [claimId]);
    expect(before.rows).toHaveLength(1);

    await pool.query(`DELETE FROM policies WHERE id = $1`, [policyUuid]);

    const after = await pool.query(`SELECT id FROM claims WHERE id = $1`, [claimId]);
    expect(after.rows).toHaveLength(0);
  });

  it("filters claims by holder — idx_claims_holder path", async () => {
    const policyA = await insertPolicy("POL-A");
    const policyB = await insertPolicy("POL-B");

    const OTHER_HOLDER = "GDIFFERENTADDRESSEXAMPLE000000000000000000000000000000000";
    await insertClaim(policyA); // HOLDER
    await insertClaim(policyB, { holder: OTHER_HOLDER }); // OTHER_HOLDER

    const { rows } = await pool.query(`SELECT id FROM claims WHERE holder = $1`, [HOLDER]);
    expect(rows).toHaveLength(1);
  });
});

describe("reference data registry — ingestion-time entity validation", () => {
  let pool: Pool;

  // Dataset versions used across the suite.
  const DATASET_V1 = "aviation-2024.01";
  const DATASET_V2 = "aviation-2024.02";

  // Canonical entity IDs.
  const JFK = "airport:JFK";
  const LHR = "airport:LHR";
  const RETIRED = "airport:XYZ"; // retired in v2

  beforeAll(() => {
    pool = createTestPool();
  });

  afterAll(() => pool.end());

  beforeEach(async () => {
    await truncateTables(pool, [
      "oracle_readings",
      "oracle_dead_letters",
      "reference_entity_aliases",
      "reference_entities",
      "reference_datasets",
      "claims",
      "premium_revenue",
      "policies",
    ]);
    await seedDatasetV1();
    await seedDatasetV2();
  });

  // ── seeding helpers ────────────────────────────────────────────────────

  async function insertDataset(version: string, effectiveFrom: string, effectiveTo: string | null) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO reference_datasets
         (dataset_key, version, effective_from, effective_to, status)
       VALUES ('aviation', $1, $2, $3, 'active')
       RETURNING id`,
      [version, effectiveFrom, effectiveTo]
    );
    return rows[0].id;
  }

  async function insertEntity(
    datasetId: string,
    canonicalId: string,
    entityType: string,
    status: "active" | "retired" = "active"
  ) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO reference_entities
         (dataset_id, canonical_id, entity_type, status)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [datasetId, canonicalId, entityType, status]
    );
    return rows[0].id;
  }

  async function insertAlias(
    datasetId: string,
    entityId: string,
    provider: string,
    providerEntityId: string
  ) {
    await pool.query(
      `INSERT INTO reference_entity_aliases
         (dataset_id, entity_id, provider, provider_entity_id)
       VALUES ($1, $2, $3, $4)`,
      [datasetId, entityId, provider, providerEntityId]
    );
  }

  async function seedDatasetV1() {
    const ds = await insertDataset(DATASET_V1, "2024-01-01T00:00:00Z", "2024-02-01T00:00:00Z");
    const jfk = await insertEntity(ds, JFK, "airport");
    const lhr = await insertEntity(ds, LHR, "airport");
    await insertAlias(ds, jfk, "nexus", "JFK");
    await insertAlias(ds, jfk, "aviationstack", "jfk-intl");
    await insertAlias(ds, lhr, "nexus", "LHR");
  }

  async function seedDatasetV2() {
    const ds = await insertDataset(DATASET_V2, "2024-02-01T00:00:00Z", null);
    const jfk = await insertEntity(ds, JFK, "airport");
    const lhr = await insertEntity(ds, LHR, "airport");
    const retired = await insertEntity(ds, RETIRED, "airport", "retired");
    await insertAlias(ds, jfk, "nexus", "JFK");
    await insertAlias(ds, lhr, "nexus", "LHR");
    await insertAlias(ds, retired, "nexus", "XYZ");
  }

  // ── ingestion helpers ──────────────────────────────────────────────────

  /**
   * Simulates the ingestion hook in `src/services/oracleMonitor.ts`:
   * resolve the provider-native entity against the pinned dataset version.
   * Accepted readings are written to `oracle_readings`; rejected ones go to
   * `oracle_dead_letters` with a reason and never reach quorum.
   */
  async function ingestReading(params: {
    datasetVersion: string;
    provider: string;
    providerEntityId: string;
    value: string;
    source: string;
  }): Promise<{ accepted: boolean; canonicalId?: string; reason?: string }> {
    const { datasetVersion, provider, providerEntityId, value, source } = params;

    const { rows: dsRows } = await pool.query<{ id: string }>(
      `SELECT id FROM reference_datasets WHERE version = $1`,
      [datasetVersion]
    );
    if (dsRows.length === 0) {
      throw new Error(`unknown dataset version ${datasetVersion}`);
    }
    const datasetId = dsRows[0].id;

    const { rows: aliasRows } = await pool.query<{
      canonical_id: string;
      status: string;
    }>(
      `SELECT e.canonical_id, e.status
         FROM reference_entity_aliases a
         JOIN reference_entities e ON e.id = a.entity_id
        WHERE a.dataset_id = $1 AND a.provider = $2 AND a.provider_entity_id = $3`,
      [datasetId, provider, providerEntityId]
    );

    let reason: string | undefined;
    let canonicalId: string | undefined;

    if (aliasRows.length === 0) {
      reason = "unknown_entity";
    } else if (aliasRows.length > 1) {
      reason = "ambiguous_entity";
    } else if (aliasRows[0].status === "retired") {
      reason = "retired_entity";
    } else {
      canonicalId = aliasRows[0].canonical_id;
    }

    if (reason) {
      await pool.query(
        `INSERT INTO oracle_dead_letters
           (dataset_version, provider, provider_entity_id, reason, payload)
         VALUES ($1, $2, $3, $4, $5)`,
        [datasetVersion, provider, providerEntityId, reason, JSON.stringify({ value, source })]
      );
      return { accepted: false, reason };
    }

    await pool.query(
      `INSERT INTO oracle_readings
         (dataset_version, canonical_entity_id, provider, value, source)
       VALUES ($1, $2, $3, $4, $5)`,
      [datasetVersion, canonicalId, provider, value, source]
    );
    return { accepted: true, canonicalId };
  }

  async function quorumCount(datasetVersion: string, canonicalId: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(DISTINCT source)::text AS count
         FROM oracle_readings
        WHERE dataset_version = $1 AND canonical_entity_id = $2`,
      [datasetVersion, canonicalId]
    );
    return Number(rows[0].count);
  }

  // ── tests ──────────────────────────────────────────────────────────────

  it("accepts a valid aliased entity and resolves it to the canonical ID", async () => {
    const result = await ingestReading({
      datasetVersion: DATASET_V2,
      provider: "aviationstack",
      providerEntityId: "jfk-intl",
      value: "42",
      source: "aviationstack",
    });

    // aviationstack alias only exists in v1, so v2 must reject it as unknown.
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("unknown_entity");

    const v1 = await ingestReading({
      datasetVersion: DATASET_V1,
      provider: "aviationstack",
      providerEntityId: "jfk-intl",
      value: "42",
      source: "aviationstack",
    });
    expect(v1.accepted).toBe(true);
    expect(v1.canonicalId).toBe(JFK);

    const { rows } = await pool.query(
      `SELECT canonical_entity_id FROM oracle_readings WHERE dataset_version = $1`,
      [DATASET_V1]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].canonical_entity_id).toBe(JFK);
  });

  it("rejects an unknown entity into the dead-letter path", async () => {
    const result = await ingestReading({
      datasetVersion: DATASET_V2,
      provider: "nexus",
      providerEntityId: "NOPE",
      value: "7",
      source: "nexus",
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("unknown_entity");

    const { rows } = await pool.query(
      `SELECT reason FROM oracle_dead_letters WHERE provider_entity_id = 'NOPE'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("unknown_entity");

    // Never counted toward quorum.
    expect(await quorumCount(DATASET_V2, JFK)).toBe(0);
  });

  it("rejects a retired entity into the dead-letter path", async () => {
    const result = await ingestReading({
      datasetVersion: DATASET_V2,
      provider: "nexus",
      providerEntityId: "XYZ",
      value: "3",
      source: "nexus",
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("retired_entity");

    const { rows } = await pool.query(
      `SELECT reason FROM oracle_dead_letters WHERE provider_entity_id = 'XYZ'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("retired_entity");

    const readings = await pool.query(
      `SELECT id FROM oracle_readings WHERE canonical_entity_id = $1`,
      [RETIRED]
    );
    expect(readings.rows).toHaveLength(0);
  });

  it("rejects an ambiguous alias match", async () => {
    // Add a second alias for the same provider-native ID pointing at LHR.
    const { rows: dsRows } = await pool.query<{ id: string }>(
      `SELECT id FROM reference_datasets WHERE version = $1`,
      [DATASET_V2]
    );
    const { rows: lhrRows } = await pool.query<{ id: string }>(
      `SELECT id FROM reference_entities WHERE dataset_id = $1 AND canonical_id = $2`,
      [dsRows[0].id, LHR]
    );
    await insertAlias(dsRows[0].id, lhrRows[0].id, "nexus", "JFK");

    const result = await ingestReading({
      datasetVersion: DATASET_V2,
      provider: "nexus",
      providerEntityId: "JFK",
      value: "11",
      source: "nexus",
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("ambiguous_entity");

    const { rows } = await pool.query(
      `SELECT reason FROM oracle_dead_letters WHERE provider_entity_id = 'JFK'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("ambiguous_entity");
  });

  it("pins readings to the dataset version they were ingested under", async () => {
    // Same provider-native ID resolves in v1 but is unknown in v2.
    const v1 = await ingestReading({
      datasetVersion: DATASET_V1,
      provider: "aviationstack",
      providerEntityId: "jfk-intl",
      value: "42",
      source: "aviationstack",
    });
    expect(v1.accepted).toBe(true);

    const v2 = await ingestReading({
      datasetVersion: DATASET_V2,
      provider: "aviationstack",
      providerEntityId: "jfk-intl",
      value: "42",
      source: "aviationstack",
    });
    expect(v2.accepted).toBe(false);

    // The accepted v1 reading retains its pinned version and canonical ID.
    const { rows } = await pool.query(
      `SELECT dataset_version, canonical_entity_id FROM oracle_readings`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].dataset_version).toBe(DATASET_V1);
    expect(rows[0].canonical_entity_id).toBe(JFK);
  });

  it("a rejected entity never reaches quorum or consensus", async () => {
    // Two valid sources plus one unknown entity.
    await ingestReading({
      datasetVersion: DATASET_V2,
      provider: "nexus",
      providerEntityId: "JFK",
      value: "42",
      source: "nexus",
    });
    await ingestReading({
      datasetVersion: DATASET_V2,
      provider: "nexus",
      providerEntityId: "LHR",
      value: "42",
      source: "nexus",
    });
    const rejected = await ingestReading({
      datasetVersion: DATASET_V2,
      provider: "nexus",
      providerEntityId: "NOPE",
      value: "42",
      source: "nexus",
    });
    expect(rejected.accepted).toBe(false);

    // Quorum for JFK counts only the accepted reading.
    expect(await quorumCount(DATASET_V2, JFK)).toBe(1);

    // The rejected reading is not present in the readings table at all.
    const { rows } = await pool.query(
      `SELECT id FROM oracle_readings WHERE canonical_entity_id IS NULL`
    );
    expect(rows).toHaveLength(0);

    const deadLetters = await pool.query(
      `SELECT id FROM oracle_dead_letters WHERE provider_entity_id = 'NOPE'`
    );
    expect(deadLetters.rows).toHaveLength(1);
  });
});
