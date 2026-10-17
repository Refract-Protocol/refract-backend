import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RelayerKeyring } from "./relayerKeyring.ts";

describe("RelayerKeyring & Multi-Submitter Quorum (Issue #190)", () => {
  const sampleKeys = [
    {
      keyId: "relayer-1",
      publicKey: "GPUBLICKEY1",
      secretSeed: "secret-seed-relayer-1-minimum-16",
      network: "testnet" as const,
      active: true,
    },
    {
      keyId: "relayer-2",
      publicKey: "GPUBLICKEY2",
      secretSeed: "secret-seed-relayer-2-minimum-16",
      network: "testnet" as const,
      active: true,
    },
    {
      keyId: "relayer-3",
      publicKey: "GPUBLICKEY3",
      secretSeed: "secret-seed-relayer-3-minimum-16",
      network: "testnet" as const,
      active: true,
    },
  ];

  it("enforces N-of-M multi-submitter threshold, handles partial signer faults, and guarantees idempotency per decisionId", () => {
    const failingSigners = new Set<string>(["relayer-1"]);

    const keyring = new RelayerKeyring({
      keys: sampleKeys,
      feedPolicies: [
        {
          feedId: "stablecoin_depeg",
          network: "testnet",
          isPayoutTriggering: true,
          requiredSignatures: 2,
        },
      ],
      signerFaultInjector: (keyId) => failingSigners.has(keyId),
    });

    // 1. relayer-1 fails, but relayer-2 and relayer-3 succeed -> 2-of-3 met
    const pub1 = keyring.publishWithThreshold({
      decisionId: "dec-501",
      feedId: "stablecoin_depeg",
      network: "testnet",
      payloadCanonical: '{"value":0.92}',
    });
    assert.equal(pub1.authoritativePublished, true);
    assert.equal(pub1.collectedSignatures.length, 2);
    assert.deepEqual(pub1.failedKeyIds, ["relayer-1"]);
    assert.equal(pub1.replayedFromIdempotentCache, false);

    // 2. Replaying the same decisionId returns cached result idempotently without re-publishing
    const pub1Replay = keyring.publishWithThreshold({
      decisionId: "dec-501",
      feedId: "stablecoin_depeg",
      network: "testnet",
      payloadCanonical: '{"value":0.92}',
    });
    assert.equal(pub1Replay.authoritativePublished, true);
    assert.equal(pub1Replay.replayedFromIdempotentCache, true);

    // 3. Two signers fail -> only 1 signature collected (< 2 required) -> blocked
    failingSigners.add("relayer-2");
    const pubFailed = keyring.publishWithThreshold({
      decisionId: "dec-502",
      feedId: "stablecoin_depeg",
      network: "testnet",
      payloadCanonical: '{"value":0.91}',
    });
    assert.equal(pubFailed.authoritativePublished, false);
    assert.equal(pubFailed.failureReason, "THRESHOLD_NOT_MET");
  });

  it("rotates keys without restart and fails startup validation when threshold exceeds active keyring size", () => {
    const keyring = new RelayerKeyring({
      keys: sampleKeys,
      feedPolicies: [
        {
          feedId: "stablecoin_depeg",
          network: "testnet",
          isPayoutTriggering: true,
          requiredSignatures: 2,
        },
      ],
    });

    const rot = keyring.rotateKey({
      revokeKeyId: "relayer-1",
      newKey: {
        keyId: "relayer-4-replacement",
        publicKey: "GPUBLICKEY4",
        secretSeed: "secret-seed-relayer-4-minimum-16",
        network: "testnet",
        active: true,
      },
      reason: "Scheduled quarterly key rotation",
      nowMs: 1_700_000_000_000,
    });
    assert.equal(rot.revokedKeyId, "relayer-1");
    assert.equal(rot.activatedKeyId, "relayer-4-replacement");
    assert.equal(keyring.getRotationAuditLog().length, 1);

    // Startup validation fails when threshold (4) > configured active keys (3)
    assert.throws(() => {
      new RelayerKeyring({
        keys: sampleKeys,
        feedPolicies: [
          {
            feedId: "stablecoin_depeg",
            network: "testnet",
            isPayoutTriggering: true,
            requiredSignatures: 4,
          },
        ],
      });
    }, /startup validation failed/);
  });
});
