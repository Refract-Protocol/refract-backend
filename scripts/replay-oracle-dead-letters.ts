/**
 * Operator tooling for the oracle dead-letter queue.
 *
 * Inspect, replay, and purge dead-lettered oracle readings once the
 * underlying fault is fixed. Requires DATABASE_URL and the migration
 * src/db/migrations/004_oracle_dead_letter_queue.sql applied.
 *
 *   npx ts-node scripts/replay-oracle-dead-letters.ts depth
 *   npx ts-node scripts/replay-oracle-dead-letters.ts replay [--limit <n>]
 *   npx ts-node scripts/replay-oracle-dead-letters.ts replay --id <deadLetterId>
 *   npx ts-node scripts/replay-oracle-dead-letters.ts purge [--days <n>]
 */
import { Pool } from "pg";
import { OracleDeadLetterRepository } from "../src/oracle/oracle-dead-letter.repository";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({ connectionString });
  const deadLetters = new OracleDeadLetterRepository(pool);

  try {
    const command = process.argv[2];
    switch (command) {
      case "depth":
        console.log(await deadLetters.depth());
        break;
      case "replay": {
        const id = flag("--id");
        if (id) {
          console.log(await deadLetters.replay(id));
        } else {
          console.log(await deadLetters.replayPending(parseInt(flag("--limit") ?? "100", 10)));
        }
        break;
      }
      case "purge":
        console.log(await deadLetters.purgeReplayed(parseInt(flag("--days") ?? "30", 10)));
        break;
      default:
        throw new Error(`Unknown command "${command}" (expected depth | replay | purge)`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
