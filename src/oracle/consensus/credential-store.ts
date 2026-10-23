import { DeleteSecretCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/**
 * Where source/provider credentials live. The ledger only ever holds the
 * opaque `credentialRef`. Offboarding asks the store to delete the secret.
 * Revoking the key inside the provider's own portal is a manual step (see
 * the runbook).
 */
export interface SourceCredentialStore {
  /** Deletes the secret. Must be idempotent: deleting a missing secret succeeds. */
  delete(credentialRef: string): Promise<void>;
}

export const SOURCE_CREDENTIAL_STORE = Symbol("SOURCE_CREDENTIAL_STORE");

/** Local/dev store. Also used when no secrets backend is configured. */
export class InMemoryCredentialStore implements SourceCredentialStore {
  private readonly secrets = new Map<string, string>();

  set(ref: string, secret: string): void {
    this.secrets.set(ref, secret);
  }

  has(ref: string): boolean {
    return this.secrets.has(ref);
  }

  async delete(ref: string): Promise<void> {
    this.secrets.delete(ref);
  }
}

/** AWS Secrets Manager, where `credentialRef` is the secret's name or ARN. */
export class SecretsManagerCredentialStore implements SourceCredentialStore {
  constructor(
    private readonly client: Pick<SecretsManagerClient, "send">,
    private readonly recoveryWindowDays: number,
  ) {}

  async delete(ref: string): Promise<void> {
    try {
      await this.client.send(new DeleteSecretCommand({ SecretId: ref, RecoveryWindowInDays: this.recoveryWindowDays }));
    } catch (err) {
      const { name, message } = err as { name?: string; message?: string };
      // Already gone, or already scheduled for deletion: the goal is met.
      if (name === "ResourceNotFoundException") return;
      if (name === "InvalidRequestException" && /scheduled for deletion/i.test(message ?? "")) return;
      throw err;
    }
  }
}

export function createCredentialStore(env: NodeJS.ProcessEnv = process.env): SourceCredentialStore {
  if (env.SOURCE_CREDENTIALS_BACKEND === "aws-secrets-manager") {
    const days = Number(env.SOURCE_CREDENTIALS_RECOVERY_WINDOW_DAYS ?? 7);
    return new SecretsManagerCredentialStore(new SecretsManagerClient({}), Number.isFinite(days) ? days : 7);
  }
  return new InMemoryCredentialStore();
}
