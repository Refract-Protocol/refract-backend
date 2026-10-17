import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_PASSPHRASES,
  validateCrossNetworkConfigParity,
} from "./crossNetworkConfigParityValidator.ts";

test("validateCrossNetworkConfigParity passes on valid single-network config and rejects mixed-network keys or passphrase mismatches", () => {
  // 1. Valid testnet config
  const valid = validateCrossNetworkConfigParity({
    env: {
      STELLAR_NETWORK: "testnet",
      REFRACT_POOL_CONTRACT_ID_TESTNET: "CDPOOL_TEST",
      REFRACT_ORACLE_CONTRACT_ID_TESTNET: "CDORACLE_TEST",
      RELAYER_SECRET_KEY_TESTNET: "S_TEST_SECRET_DO_NOT_ECHO",
    },
    rpcReportedPassphrase: CANONICAL_PASSPHRASES.testnet,
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.warnings.length, 0);

  // 2. Mixed network keys + wrong RPC passphrase fails without leaking secret value
  const mixed = validateCrossNetworkConfigParity({
    env: {
      STELLAR_NETWORK: "testnet",
      REFRACT_ORACLE_CONTRACT_ID_TESTNET: "CDORACLE_TEST",
      RELAYER_SECRET_KEY_MAINNET: "S_MAINNET_SECRET_VALUE",
    },
    rpcReportedPassphrase: CANONICAL_PASSPHRASES.mainnet,
  });
  assert.equal(mixed.valid, false);
  assert.deepEqual(mixed.offendingMixedKeys, ["RELAYER_SECRET_KEY_MAINNET"]);
  assert.ok(mixed.errors.some((e) => e.includes("MIXED_NETWORK_ENV_KEYS")));
  assert.ok(mixed.errors.some((e) => e.includes("RPC_PASSPHRASE_MISMATCH")));
  assert.equal(
    mixed.errors.some((e) => e.includes("S_MAINNET_SECRET_VALUE")),
    false
  );
  assert.ok(mixed.warnings.some((w) => w.includes("INCOMPLETE_PAYOUT_CONFIG")));
});
