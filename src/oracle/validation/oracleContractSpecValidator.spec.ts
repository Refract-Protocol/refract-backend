import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXPECTED_REFRACT_ORACLE_SPEC,
  validateOracleContractSpecOnStartup,
  type SorobanFunctionSpec,
} from "./oracleContractSpecValidator.ts";

test("validateOracleContractSpecOnStartup passes on matching spec and emits specHash", async () => {
  const res = await validateOracleContractSpecOnStartup({
    network: "testnet",
    contractId: "CDORACLE1234567890",
    fetchRemoteSpec: async () =>
      EXPECTED_REFRACT_ORACLE_SPEC.map((fn) => ({
        ...fn,
        inputs: fn.inputs.map((i) => ({ ...i })),
      })),
  });

  assert.equal(res.valid, true);
  assert.equal(res.skipped, false);
  assert.equal(res.mismatches.length, 0);
  assert.ok(res.specHash && res.specHash.length === 64);
});

test("validateOracleContractSpecOnStartup fails closed on missing function, argument type mismatch, and RPC timeout", async () => {
  // 1. Missing get_quorum_config + wrong type on publish_reading.value
  const mutatedSpec: SorobanFunctionSpec[] = [
    {
      name: "publish_reading",
      inputs: [
        { name: "feed_id", type: "Symbol" },
        { name: "value", type: "U64" }, // expected I128
        { name: "observed_at", type: "U64" },
        { name: "provenance_hash", type: "BytesN<32>" },
      ],
      output: "Void",
    },
    {
      name: "get_latest_reading",
      inputs: [{ name: "feed_id", type: "Symbol" }],
      output: "Option<OracleReading>",
    },
  ];

  const mismatchRes = await validateOracleContractSpecOnStartup({
    network: "testnet",
    contractId: "CDORACLE1234567890",
    fetchRemoteSpec: async () => mutatedSpec,
  });

  assert.equal(mismatchRes.valid, false);
  assert.ok(
    mismatchRes.mismatches.some((m) =>
      m.includes("ARGUMENT_MISMATCH: Function 'publish_reading'")
    )
  );
  assert.ok(
    mismatchRes.mismatches.some((m) =>
      m.includes("MISSING_FUNCTION") && m.includes("get_quorum_config")
    )
  );

  // 2. RPC timeout fails closed
  const timeoutRes = await validateOracleContractSpecOnStartup({
    network: "mainnet",
    contractId: "CDORACLE1234567890",
    fetchRemoteSpec: async () => {
      throw new Error("Soroban RPC timeout after 5000ms");
    },
  });
  assert.equal(timeoutRes.valid, false);
  assert.ok(
    timeoutRes.mismatches[0].includes("RPC_TIMEOUT_OR_UNAVAILABLE")
  );

  // 3. Explicit skip flag logs loud warning for offline dev
  const skippedRes = await validateOracleContractSpecOnStartup({
    network: "standalone",
    contractId: "CDORACLE1234567890",
    skipValidation: true,
    fetchRemoteSpec: async () => {
      throw new Error("Should not be called when skipped");
    },
  });
  assert.equal(skippedRes.valid, true);
  assert.equal(skippedRes.skipped, true);
  assert.ok(skippedRes.warning?.includes("SKIP_ORACLE_SPEC_VALIDATION=true"));
});
