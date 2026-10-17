import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ContractSpecRevalidatorService,
  InMemoryContractSpecValidationStore,
  type ContractAbiSpec,
} from "./contractSpecRevalidator.ts";

function buildExpectedOracleSpec(): ContractAbiSpec {
  return {
    contractName: "RefractOracle",
    contractAddress: "CCORACLE1234567890",
    wasmHash: "wasm_v1_hash",
    functions: [
      {
        name: "publish_reading",
        inputs: [
          { name: "feed_symbol", type: "Symbol" },
          { name: "value", type: "i128" },
          { name: "timestamp", type: "u64" },
        ],
        outputs: ["void"],
      },
      {
        name: "get_latest_reading",
        inputs: [{ name: "feed_symbol", type: "Symbol" }],
        outputs: ["i128"],
      },
    ],
  };
}

test("Issue #284: detects breaking on-chain ABI changes, produces diff report, blocks publish/settle across restarts, and supports operator override", async () => {
  const sharedStore = new InMemoryContractSpecValidationStore();
  const service1 = new ContractSpecRevalidatorService({
    store: sharedStore,
    minFetchIntervalMs: 30_000,
  });

  const expected = buildExpectedOracleSpec();
  service1.registerExpectedContractSpec(expected);

  const t0 = 1_750_000_000_000;
  // 1. Clean initial validation (plus an additive helper function on-chain)
  const validRes = await service1.revalidateContract(
    "RefractOracle",
    async () => ({
      ...expected,
      functions: [
        ...expected.functions,
        { name: "version", inputs: [], outputs: ["u32"] },
      ],
    }),
    t0
  );
  assert.equal(validRes.status, "valid");
  assert.equal(validRes.canPublishOrSettle, true);
  assert.deepEqual(validRes.diffReport?.addedFunctions, ["version"]);
  assert.equal(service1.canOperate("RefractOracle").allowed, true);

  // 2. On-chain contract upgrade changes `publish_reading` parameter type (`i128` -> `u128`) and removes `get_latest_reading`
  const mismatchRes = await service1.revalidateContract(
    "RefractOracle",
    async () => ({
      contractName: "RefractOracle",
      contractAddress: "CCORACLE1234567890",
      wasmHash: "wasm_v2_breaking",
      functions: [
        {
          name: "publish_reading",
          inputs: [
            { name: "feed_symbol", type: "Symbol" },
            { name: "value", type: "u128" }, // Changed from i128!
            { name: "timestamp", type: "u64" },
          ],
          outputs: ["void"],
        },
      ],
    }),
    t0 + 5_000,
    { forceOnUpgradeEvent: true }
  );

  assert.equal(mismatchRes.status, "mismatch");
  assert.equal(mismatchRes.canPublishOrSettle, false);
  assert.equal(mismatchRes.circuitBreakerTripped, true);
  assert.deepEqual(mismatchRes.diffReport?.removedFunctions, ["get_latest_reading"]);
  assert.equal(mismatchRes.diffReport?.changedFunctions[0].functionName, "publish_reading");
  assert.match(mismatchRes.highSeverityAlert ?? "", /publish_reading/);

  // 3. Simulate restart: new service instance inherits the persisted mismatch block
  const serviceAfterRestart = new ContractSpecRevalidatorService({
    store: sharedStore,
  });
  serviceAfterRestart.registerExpectedContractSpec(expected);
  assert.equal(serviceAfterRestart.canOperate("RefractOracle").allowed, false);
  assert.equal(serviceAfterRestart.canOperate("RefractOracle").status, "mismatch");

  // 4. Operator override with reason clears the block
  const overridden = serviceAfterRestart.applyOperatorOverride({
    contractName: "RefractOracle",
    actorId: "admin_ops",
    reason: "Adapter encoding shim enabled for v2 contract",
    nowMs: t0 + 10_000,
  });
  assert.equal(overridden.status, "operator_overridden");
  assert.equal(serviceAfterRestart.canOperate("RefractOracle").allowed, true);
});

test("Issue #284: RPC errors transition to distinct 'unknown' state (fail-closed) rather than 'mismatch'", async () => {
  const service = new ContractSpecRevalidatorService();
  service.registerExpectedContractSpec(buildExpectedOracleSpec());

  const rpcErrRes = await service.revalidateContract(
    "RefractOracle",
    async () => {
      throw new Error("Soroban RPC timeout");
    },
    1_750_000_000_000
  );

  assert.equal(rpcErrRes.status, "unknown");
  assert.equal(rpcErrRes.canPublishOrSettle, false);
  assert.equal(rpcErrRes.circuitBreakerTripped, false);
  assert.match(rpcErrRes.highSeverityAlert ?? "", /CONTRACT_SPEC_RPC_UNKNOWN/);
});
