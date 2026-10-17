import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  OperatorIdentityRegistry,
  signOperatorRegistrationRequest,
} from "./operatorRegistry.ts";

function makeEd25519KeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

describe("OperatorIdentityRegistry (Issue #191)", () => {
  it("verifies key possession on registration and rejects duplicate submission keys or replayed nonces", () => {
    const registry = new OperatorIdentityRegistry();
    const nowMs = 1_700_000_000_000;
    const kp1 = makeEd25519KeyPair();

    const signedReq1 = signOperatorRegistrationRequest(
      {
        operatorId: "op-node-1",
        submissionPublicKeyPem: kp1.publicKeyPem,
        supportedFeedKeys: ["rainfall-miami", "wind-tampa"],
        requestedAtMs: nowMs - 1_000,
        nonce: "reg-nonce-1",
      },
      kp1.privateKeyPem
    );

    const rec = registry.registerOperator(signedReq1, nowMs);
    assert.equal(rec.operatorId, "op-node-1");
    assert.equal(rec.status, "pending");

    // Replay of the same registration request is rejected
    assert.throws(() => {
      registry.registerOperator(signedReq1, nowMs + 500);
    }, /REPLAYED_REGISTRATION_NONCE/);

    // Second operator attempting to register with op-node-1's public key is rejected
    const duplicateKeyReq = signOperatorRegistrationRequest(
      {
        operatorId: "op-sybil-2",
        submissionPublicKeyPem: kp1.publicKeyPem,
        supportedFeedKeys: ["rainfall-miami"],
        requestedAtMs: nowMs,
        nonce: "reg-nonce-2",
      },
      kp1.privateKeyPem
    );
    assert.throws(() => {
      registry.registerOperator(duplicateKeyReq, nowMs + 500);
    }, /DUPLICATE_SUBMISSION_KEY/);
  });

  it("enforces one-operator-one-quorum-vote invariant, excludes suspended operators, and reconciles chain state idempotently", () => {
    const registry = new OperatorIdentityRegistry();
    const nowMs = 1_700_000_000_000;
    const kp1 = makeEd25519KeyPair();
    const kp2 = makeEd25519KeyPair();

    registry.registerOperator(
      signOperatorRegistrationRequest(
        {
          operatorId: "op-1",
          submissionPublicKeyPem: kp1.publicKeyPem,
          supportedFeedKeys: ["rainfall-miami"],
          requestedAtMs: nowMs,
          nonce: "n-1",
        },
        kp1.privateKeyPem
      ),
      nowMs
    );
    registry.registerOperator(
      signOperatorRegistrationRequest(
        {
          operatorId: "op-2",
          submissionPublicKeyPem: kp2.publicKeyPem,
          supportedFeedKeys: ["rainfall-miami"],
          requestedAtMs: nowMs,
          nonce: "n-2",
        },
        kp2.privateKeyPem
      ),
      nowMs
    );

    registry.updateOperatorStatus("op-1", "active", "Passed onboarding", nowMs);
    registry.updateOperatorStatus("op-2", "suspended", "Missed heartbeats", nowMs);

    // op-1 submits 3 readings in the same window + op-2 (suspended) submits 1 reading -> cannot satisfy 2-operator quorum
    const check1 = registry.filterOperatorAttributedReadingsForQuorum(
      "rainfall-miami",
      [
        {
          operatorId: "op-1",
          feedKey: "rainfall-miami",
          value: 100,
          observedAtMs: nowMs + 1_000,
        },
        {
          operatorId: "op-1",
          feedKey: "rainfall-miami",
          value: 101,
          observedAtMs: nowMs + 2_000,
        },
        {
          operatorId: "op-1",
          feedKey: "rainfall-miami",
          value: 102,
          observedAtMs: nowMs + 3_000,
        },
        {
          operatorId: "op-2",
          feedKey: "rainfall-miami",
          value: 102,
          observedAtMs: nowMs + 2_500,
        },
      ],
      2
    );

    assert.equal(check1.quorumSatisfied, false);
    assert.equal(check1.eligibleReadings.length, 1);
    assert.equal(check1.eligibleReadings[0]?.value, 102);
    assert.equal(check1.excludedReadings.length, 3);

    // Reconcile from chain snapshot where op-2 is restored to active on-chain
    const sync1 = registry.reconcileFromChainSnapshot(
      [
        {
          operatorId: "op-2",
          submissionPublicKeyPem: kp2.publicKeyPem,
          supportedFeedKeys: ["rainfall-miami"],
          registeredAtMs: nowMs,
          status: "active",
        },
      ],
      55_000,
      nowMs + 5_000
    );
    assert.equal(sync1.updatedCount, 1);
    // Second identical reconciliation is a no-op (idempotent)
    const sync2 = registry.reconcileFromChainSnapshot(
      [
        {
          operatorId: "op-2",
          submissionPublicKeyPem: kp2.publicKeyPem,
          supportedFeedKeys: ["rainfall-miami"],
          registeredAtMs: nowMs,
          status: "active",
        },
      ],
      55_000,
      nowMs + 6_000
    );
    assert.equal(sync2.updatedCount, 0);
    assert.equal(registry.getOperator("op-2")?.status, "active");
  });
});
