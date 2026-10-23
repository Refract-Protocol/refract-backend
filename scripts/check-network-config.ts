/**
 * Pre-deploy check: does this environment target exactly one Stellar
 * network? Exits non-zero and lists every problem if not. Add --live to also
 * ask the RPC/Horizon endpoints which network they serve.
 *
 *   npx ts-node scripts/check-network-config.ts [--live]
 */
import "dotenv/config";
import { validateNetworkConsistency, verifyNetworkLive } from "../src/config/network-consistency";

async function main(): Promise<void> {
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

void main();
