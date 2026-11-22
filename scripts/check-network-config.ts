/**
 * Pre-deploy check: does this environment target exactly one Stellar
 * network? Exits non-zero and lists every problem if not. Add --live to also
 * ask the RPC/Horizon endpoints which network they serve.
 *
 *   npx ts-node scripts/check-network-config.ts [--live]
 */
import "dotenv/config";
import { STELLAR_NETWORKS, validateNetworkConsistency, verifyNetworkLive } from "../src/config/network-consistency";

const ACCEPTED_NETWORKS = Object.keys(STELLAR_NETWORKS).join(", ");

async function main(): Promise<void> {
  if (!process.env.STELLAR_NETWORK?.trim()) {
    console.error(`error: STELLAR_NETWORK is not set. Set it to one of: ${ACCEPTED_NETWORKS}`);
    process.exit(1);
  }

  const report = validateNetworkConsistency(process.env);
  report.warnings.forEach((w) => console.warn(`warn: ${w}`));
  report.errors.forEach((e) => console.error(`error: ${e}`));

  if (report.ok && process.argv.includes("--live")) {
    const live = await verifyNetworkLive(report.resolved!);
    live.unreachable.forEach((w) => console.warn(`warn: ${w}`));
    live.mismatches.forEach((e) => console.error(`error: ${e}`));
    if (live.mismatches.length > 0) process.exit(1);
  }
  if (!report.ok) process.exit(1);
  console.log(`ok: configured for ${report.resolved!.network} only`);
}

void main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
