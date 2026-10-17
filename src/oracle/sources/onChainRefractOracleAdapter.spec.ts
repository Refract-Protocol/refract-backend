import { test } from "node:test";
import assert from "node:assert/strict";
import { OnChainRefractOracleAdapter } from "./onChainRefractOracleAdapter.ts";

test("OnChainRefractOracleAdapter ingests independent on-chain readings and excludes self-published relayer entries", () => {
  const adapter = new OnChainRefractOracleAdapter(["G_LOCAL_RELAYER_1"], 60_000);

  // Self-published entry by local relayer is excluded from independent quorum
  const selfPub = adapter.evaluateOnChainEntry(
    {
      contractId: "C_ORACLE_1",
      feedId: "XLM_USD",
      scaledValue: 125_000n,
      decimals: 6,
      ledgerSequence: 500,
      ledgerTimestampMs: 50_000,
      txHash: "tx-self",
      submitterAddress: "G_LOCAL_RELAYER_1",
    },
    55_000
  );
  assert.equal(selfPub.acceptedForIndependentQuorum, false);
  assert.equal(selfPub.reason, "self_published_excluded");

  // Independent third-party oracle publisher is accepted and scaled properly
  const independent = adapter.evaluateOnChainEntry(
    {
      contractId: "C_ORACLE_1",
      feedId: "XLM_USD",
      scaledValue: 125_000n,
      decimals: 6,
      ledgerSequence: 501,
      ledgerTimestampMs: 52_000,
      txHash: "tx-ext",
      submitterAddress: "G_EXTERNAL_PUBLISHER",
    },
    55_000
  );
  assert.equal(independent.acceptedForIndependentQuorum, true);
  assert.ok(Math.abs((independent.normalizedValue ?? 0) - 0.125) < 1e-9);
  assert.equal(independent.provenance?.ledgerSequence, 501);
});
