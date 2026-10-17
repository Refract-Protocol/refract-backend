import { createHmac } from "node:crypto";
import { type SecretsProvider } from "./secrets.ts";

export interface SignedTransactionEnvelope {
  signerType: "in_process_dev" | "remote_kms_hsm";
  publicKey: string;
  keyVersionId: string;
  signedTxXdr: string;
}

export interface TransactionSigner {
  readonly signerType: "in_process_dev" | "remote_kms_hsm";
  getPublicKey(): Promise<string>;
  healthCheck(): Promise<boolean>;
  signTransactionXdr(unsignedTxXdr: string): Promise<SignedTransactionEnvelope>;
}

export class InProcessDevSigner implements TransactionSigner {
  public readonly signerType = "in_process_dev" as const;
  private readonly publicKey: string;
  private readonly secretsProvider: SecretsProvider;
  private readonly secretKeyName: string;

  constructor(options: {
    publicKey: string;
    secretsProvider: SecretsProvider;
    secretKeyName: string;
  }) {
    this.publicKey = options.publicKey;
    this.secretsProvider = options.secretsProvider;
    this.secretKeyName = options.secretKeyName;
  }

  public async getPublicKey(): Promise<string> {
    return this.publicKey;
  }

  public async healthCheck(): Promise<boolean> {
    const secret = await this.secretsProvider.getSecret(this.secretKeyName);
    return secret.length >= 8;
  }

  public async signTransactionXdr(
    unsignedTxXdr: string
  ): Promise<SignedTransactionEnvelope> {
    if (!unsignedTxXdr || unsignedTxXdr.trim().length === 0) {
      throw new Error("Cannot sign empty unsignedTxXdr");
    }
    // Retrieve ephemeral secret on demand rather than holding it in a long-lived field
    const ephemeralSecret = await this.secretsProvider.getSecret(
      this.secretKeyName
    );
    const sigHex = createHmac("sha256", ephemeralSecret)
      .update(unsignedTxXdr)
      .digest("hex");

    return {
      signerType: "in_process_dev",
      publicKey: this.publicKey,
      keyVersionId: "dev-local-v1",
      signedTxXdr: `${unsignedTxXdr}:sig:${sigHex}`,
    };
  }
}

export class RemoteKmsHsmSigner implements TransactionSigner {
  public readonly signerType = "remote_kms_hsm" as const;
  private readonly keyUri: string;
  private readonly rpcClient: {
    getPublicKey: (keyUri: string) => Promise<{
      publicKey: string;
      keyVersionId: string;
    }>;
    signDigest: (params: {
      keyUri: string;
      unsignedTxXdr: string;
    }) => Promise<{
      signatureHex: string;
      publicKey: string;
      keyVersionId: string;
    }>;
  };

  constructor(options: {
    keyUri: string;
    rpcClient: RemoteKmsHsmSigner["rpcClient"];
  }) {
    if (!options.keyUri) {
      throw new Error("RemoteKmsHsmSigner requires a valid KMS/HSM keyUri");
    }
    this.keyUri = options.keyUri;
    this.rpcClient = options.rpcClient;
  }

  public async getPublicKey(): Promise<string> {
    const res = await this.rpcClient.getPublicKey(this.keyUri);
    return res.publicKey;
  }

  public async healthCheck(): Promise<boolean> {
    const res = await this.rpcClient.getPublicKey(this.keyUri);
    return Boolean(res.publicKey && res.keyVersionId);
  }

  public async signTransactionXdr(
    unsignedTxXdr: string
  ): Promise<SignedTransactionEnvelope> {
    if (!unsignedTxXdr || unsignedTxXdr.trim().length === 0) {
      throw new Error("Cannot sign empty unsignedTxXdr");
    }
    const signed = await this.rpcClient.signDigest({
      keyUri: this.keyUri,
      unsignedTxXdr,
    });

    return {
      signerType: "remote_kms_hsm",
      publicKey: signed.publicKey,
      keyVersionId: signed.keyVersionId,
      signedTxXdr: `${unsignedTxXdr}:kms-sig:${signed.signatureHex}`,
    };
  }
}

export async function verifySignerReachableAtStartup(
  signer: TransactionSigner
): Promise<void> {
  let healthy = false;
  try {
    healthy = await signer.healthCheck();
  } catch (err) {
    throw new Error(
      `Signer startup verification failed (${signer.signerType}): ${
        err instanceof Error ? err.message : "unreachable"
      }`
    );
  }

  if (!healthy) {
    throw new Error(
      `Signer startup verification failed (${signer.signerType}): healthCheck returned false`
    );
  }
}
