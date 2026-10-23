import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import {
  HistoricalOracleObservation,
  HistoricalPayoutSummary,
  OracleSimulationCandidate,
  SIMULATION_COVERAGE_TYPES,
  SimulationCoverageType,
  simulateOracleParameters,
} from "../src/oracle/oracle-simulator";

const MAX_SIMULATION_READINGS = 50_000;
const MAX_SIMULATION_DAYS = 366;

const DATABASE_COVERAGE_TYPE: Record<string, SimulationCoverageType> = {
  stablecoin_depeg: "StablecoinDepeg",
  market_crash: "MarketCrash",
  liquidation_shield: "LiquidationShield",
  smart_contract_risk: "SmartContractRisk",
  flight_delay: "FlightDelay",
};

interface ReadingRow {
  coverage_type: string;
  value: string;
  source: string;
  severity: string;
  recorded_at: Date;
}

interface PayoutRow {
  coverage_type: string;
  settled_claims: string;
  payout_total: string;
}

function parseDate(value: string, label: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${label} must be a valid ISO date`);
  }
  return date;
}

function coverageTypeFromDatabase(value: string): SimulationCoverageType {
  const coverageType = DATABASE_COVERAGE_TYPE[value];
  if (!coverageType || !SIMULATION_COVERAGE_TYPES.includes(coverageType)) {
    throw new Error(`Unsupported coverage type in historical data: ${value}`);
  }
  return coverageType;
}

async function run(): Promise<void> {
  const [candidatePath, fromText, toText] = process.argv.slice(2);
  if (!candidatePath || !fromText || !toText || process.argv.length !== 5) {
    throw new Error(
      "Usage: npm run simulate:oracle -- <candidate.json> <from-ISO-date> <to-ISO-date>",
    );
  }
  const from = parseDate(fromText, "from");
  const to = parseDate(toText, "to");
  if (from >= to) {
    throw new Error("The from date must be earlier than the to date");
  }
  if (to.getTime() - from.getTime() > MAX_SIMULATION_DAYS * 86_400_000) {
    throw new Error(`Simulation windows cannot exceed ${MAX_SIMULATION_DAYS} days`);
  }

  const candidateJson = JSON.parse(await readFile(candidatePath, "utf8")) as unknown;
  const candidate = OracleSimulationCandidate.parse(candidateJson);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to read stored oracle history");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const readingResult = await pool.query<ReadingRow>(
      `SELECT coverage_type::text AS coverage_type,
              value::text AS value,
              source,
              severity,
              recorded_at
         FROM oracle_events
        WHERE recorded_at >= $1::timestamptz - ($3::integer * interval '1 second')
          AND recorded_at <= $2::timestamptz
        ORDER BY recorded_at ASC
        LIMIT $4`,
      [from, to, candidate.freshnessSeconds, MAX_SIMULATION_READINGS + 1],
    );
    if (readingResult.rows.length > MAX_SIMULATION_READINGS) {
      throw new Error(
        `History exceeds the ${MAX_SIMULATION_READINGS}-reading limit; narrow the time window`,
      );
    }
    const readings: HistoricalOracleObservation[] = readingResult.rows.map((row) => {
      const value = Number(row.value);
      if (!Number.isFinite(value)) {
        throw new Error(`Invalid numeric oracle history for ${row.coverage_type}`);
      }
      return {
        coverageType: coverageTypeFromDatabase(row.coverage_type),
        value,
        source: row.source,
        severity: row.severity,
        recordedAt: row.recorded_at,
      };
    });

    const payoutResult = await pool.query<PayoutRow>(
      `SELECT coverage_type AS coverage_type,
              COUNT(*)::text AS settled_claims,
              COALESCE(SUM(payout_amount), 0)::text AS payout_total
         FROM claims
        WHERE settled_at >= $1::timestamptz
          AND settled_at <= $2::timestamptz
        GROUP BY coverage_type`,
      [from, to],
    );
    const payouts: Partial<Record<SimulationCoverageType, HistoricalPayoutSummary>> = {};
    for (const row of payoutResult.rows) {
      const count = Number(row.settled_claims);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error(`Invalid settled claim count for ${row.coverage_type}`);
      }
      payouts[coverageTypeFromDatabase(row.coverage_type)] = {
        settledClaims: count,
        payoutTotal: row.payout_total,
      };
    }

    const result = simulateOracleParameters(readings, payouts, candidate, { from, to });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Oracle parameter simulation failed: ${message}\n`);
  process.exitCode = 1;
});
