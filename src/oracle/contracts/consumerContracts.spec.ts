import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONSUMER_CONTRACT_SPECS,
  assertProducerMatchesConsumerContract,
  verifyProducerPayloadAgainstContract,
} from "./consumerContracts.ts";

test("Issue #292: verifies all frontend and Soroban contract consumer specs and allows additive fields without ceremony", () => {
  const decisionSpec = CONSUMER_CONTRACT_SPECS.find(
    (s) => s.interfaceName === "ConsensusDecision"
  )!;
  const attestationSpec = CONSUMER_CONTRACT_SPECS.find(
    (s) => s.interfaceName === "ProvenanceAttestation"
  )!;
  const trustStatusSpec = CONSUMER_CONTRACT_SPECS.find(
    (s) => s.interfaceName === "TrustStatusResponse"
  )!;
  const onChainReadingSpec = CONSUMER_CONTRACT_SPECS.find(
    (s) => s.interfaceName === "OnChainEncodedReading"
  )!;

  // 1. ConsensusDecision with additive field (`experimentalLatencyMs`)
  const decisionRes = assertProducerMatchesConsumerContract(decisionSpec, {
    decisionId: "dec_42",
    feedId: "StablecoinDepeg",
    roundNumber: 42,
    consensusValueStroops: "100000000",
    unit: "stroops_1e7",
    confidenceScoreBps: 9800,
    trustMode: "healthy",
    decidedAtMs: 1_750_000_000_000,
    contributingSources: ["coingecko", "defillama", "horizon"],
    experimentalLatencyMs: 85,
  });
  assert.equal(decisionRes.passed, true);
  assert.deepEqual(decisionRes.additiveFields, ["experimentalLatencyMs"]);

  // 2. ProvenanceAttestation
  const attRes = assertProducerMatchesConsumerContract(attestationSpec, {
    attestationId: "att_42",
    decisionId: "dec_42",
    merkleRootHex: "aabbccddeeff0011",
    quorumPolicyVersion: 2,
    operatorSignatures: ["sig_op1", "sig_op2", "sig_op3"],
  });
  assert.equal(attRes.passed, true);

  // 3. TrustStatusResponse
  const trustRes = assertProducerMatchesConsumerContract(trustStatusSpec, {
    feedId: "StablecoinDepeg",
    circuitBreakerState: "closed",
    pausedOnChain: false,
    activeSourceCount: 5,
    lastPublishedAtMs: 1_750_000_000_000,
  });
  assert.equal(trustRes.passed, true);

  // 4. OnChainEncodedReading consumed by refract-contracts
  const onChainRes = assertProducerMatchesConsumerContract(onChainReadingSpec, {
    contractMethod: "publish_reading",
    feedSymbol: "USDC_DEPEG",
    roundId: 42,
    valueI128Stroops: "9985000",
    decimals: 7,
    timestampSec: 1_750_000_000,
    provenanceHashHex: "deadbeef01234567",
  });
  assert.equal(onChainRes.passed, true);
});

test("Issue #292: proof test — deliberately renaming a field or changing a unit fails verification with a readable named-field error", () => {
  const decisionSpec = CONSUMER_CONTRACT_SPECS.find(
    (s) => s.interfaceName === "ConsensusDecision"
  )!;

  // Deliberately rename `consensusValueStroops` -> `valueStroops` and change `unit` -> `wei_1e18`
  const brokenPayload = {
    decisionId: "dec_42",
    feedId: "StablecoinDepeg",
    roundNumber: 42,
    valueStroops: "100000000", // Renamed from consensusValueStroops!
    unit: "wei_1e18", // Changed unit!
    confidenceScoreBps: 9800,
    trustMode: "healthy",
    decidedAtMs: 1_750_000_000_000,
    contributingSources: ["coingecko"],
  };

  const check = verifyProducerPayloadAgainstContract(decisionSpec, brokenPayload);
  assert.equal(check.passed, false);
  assert.equal(
    check.violations.some(
      (v) =>
        v.fieldPath === "consensusValueStroops" &&
        v.kind === "missing_required_field"
    ),
    true
  );
  assert.equal(
    check.violations.some(
      (v) => v.fieldPath === "unit" && v.kind === "unit_mismatch"
    ),
    true
  );

  assert.throws(
    () => assertProducerMatchesConsumerContract(decisionSpec, brokenPayload),
    /missing required field "consensusValueStroops"/
  );
});
