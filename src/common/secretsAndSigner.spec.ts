import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CloudSecretsManagerAdapter,
  EnvSecretsAdapter,
  FileSecretsAdapter,
  bootstrapRequiredSecrets,
} from "./secrets.ts";
import {
  InProcessDevSigner,
  RemoteKmsHsmSigner,
  verifySignerReachableAtStartup,
} from "./signer.ts";

describe("SecretsProvider & HSM/KMS TransactionSigner (Issue #216)", () => {
  it("resolves secrets across Env, File, and CloudSecretsManager adapters with TTL caching, force refresh, and fail-fast startup validation", async () => {
    const envAdapter = new EnvSecretsAdapter({
      AVIATION_API_KEY: "  env-secret-val-123  ",
    });
    assert.equal(
      await envAdapter.getSecret("AVIATION_API_KEY"),
      "env-secret-val-123"
    );
    await assert.rejects(
      async () => envAdapter.getSecret("MISSING_SECRET"),
      /Missing required secret/
    );

    const fileAdapter = new FileSecretsAdapter("/run/secrets", (filePath) => {
      if (filePath.includes("DOCKER_PROVIDER_KEY")) {
        return "docker-mounted-secret-999\n";
      }
      throw new Error("ENOENT");
    });
    assert.equal(
      await fileAdapter.getSecret("DOCKER_PROVIDER_KEY"),
      "docker-mounted-secret-999"
    );

    let cloudFetchCount = 0;
    let currentTimeMs = 1_700_000_000_000;
    const cloudAdapter = new CloudSecretsManagerAdapter({
      cacheTtlMs: 30_000,
      nowFn: () => currentTimeMs,
      fetchFromCloud: async (secretId) => {
        cloudFetchCount += 1;
        return `cloud-${secretId}-v${cloudFetchCount}`;
      },
    });

    const resolvedBoot = await bootstrapRequiredSecrets(cloudAdapter, [
      "COINGECKO_PRO_KEY",
    ]);
    assert.equal(resolvedBoot["COINGECKO_PRO_KEY"], "cloud-COINGECKO_PRO_KEY-v1");
    assert.equal(cloudFetchCount, 1);

    // Repeat call within 30s TTL hits cache
    currentTimeMs += 10_000;
    assert.equal(
      await cloudAdapter.getSecret("COINGECKO_PRO_KEY"),
      "cloud-COINGECKO_PRO_KEY-v1"
    );
    assert.equal(cloudFetchCount, 1);

    // Forced refresh bypasses TTL cache
    assert.equal(
      await cloudAdapter.getSecret("COINGECKO_PRO_KEY", { forceRefresh: true }),
      "cloud-COINGECKO_PRO_KEY-v2"
    );
    assert.equal(cloudFetchCount, 2);
  });

  it("signs transactions via RemoteKmsHsmSigner and InProcessDevSigner without exposing private keys and fails fast when KMS is unreachable", async () => {
    const remoteSigner = new RemoteKmsHsmSigner({
      keyUri: "kms://projects/refract/locations/global/keyRings/oracle/cryptoKeys/relayer",
      rpcClient: {
        getPublicKey: async () => ({
          publicKey: "GKMSPUBLICKEY777",
          keyVersionId: "kms-ver-3",
        }),
        signDigest: async ({ unsignedTxXdr }) => ({
          signatureHex: `hsm_sig_over_${unsignedTxXdr.length}`,
          publicKey: "GKMSPUBLICKEY777",
          keyVersionId: "kms-ver-3",
        }),
      },
    });

    await verifySignerReachableAtStartup(remoteSigner);
    const kmsEnvelope = await remoteSigner.signTransactionXdr(
      "AAAAAgAAAABunsignedXdrPayload"
    );
    assert.equal(kmsEnvelope.signerType, "remote_kms_hsm");
    assert.equal(kmsEnvelope.publicKey, "GKMSPUBLICKEY777");
    assert.equal(kmsEnvelope.keyVersionId, "kms-ver-3");
    assert.ok(kmsEnvelope.signedTxXdr.includes(":kms-sig:"));

    const devSigner = new InProcessDevSigner({
      publicKey: "GDEVLOCALPUBKEY",
      secretsProvider: new EnvSecretsAdapter({
        RELAYER_SECRET_KEY: "dev-only-secret-seed-value",
      }),
      secretKeyName: "RELAYER_SECRET_KEY",
    });
    await verifySignerReachableAtStartup(devSigner);
    const devEnvelope = await devSigner.signTransactionXdr("AAAAunsignedDevXdr");
    assert.equal(devEnvelope.signerType, "in_process_dev");
    assert.ok(
      !JSON.stringify(devEnvelope).includes("dev-only-secret-seed-value")
    );

    // Unreachable remote KMS signer fails fast at startup
    const brokenKms = new RemoteKmsHsmSigner({
      keyUri: "kms://broken-hsm",
      rpcClient: {
        getPublicKey: async () => {
          throw new Error("KMS endpoint connection refused");
        },
        signDigest: async () => {
          throw new Error("KMS endpoint connection refused");
        },
      },
    });

    await assert.rejects(
      async () => verifySignerReachableAtStartup(brokenKms),
      /Signer startup verification failed/
    );
  });
});
