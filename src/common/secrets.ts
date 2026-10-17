import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface SecretsProvider {
  readonly adapterName: "env" | "file" | "cloud_secrets_manager";
  getSecret(secretName: string, options?: { forceRefresh?: boolean }): Promise<string>;
}

export class EnvSecretsAdapter implements SecretsProvider {
  public readonly adapterName = "env" as const;
  private readonly envSource: Record<string, string | undefined>;

  constructor(envSource: Record<string, string | undefined> = process.env) {
    this.envSource = envSource;
  }

  public async getSecret(secretName: string): Promise<string> {
    const val = this.envSource[secretName];
    if (!val || val.trim().length === 0) {
      throw new Error(`Missing required secret "${secretName}" in EnvSecretsAdapter`);
    }
    return val.trim();
  }
}

export class FileSecretsAdapter implements SecretsProvider {
  public readonly adapterName = "file" as const;
  private readonly secretsDir: string;
  private readonly fileReader: (filePath: string) => string;

  constructor(
    secretsDir: string = "/run/secrets",
    fileReader: (filePath: string) => string = (p) => readFileSync(p, "utf8")
  ) {
    this.secretsDir = secretsDir;
    this.fileReader = fileReader;
  }

  public async getSecret(secretName: string): Promise<string> {
    try {
      const raw = this.fileReader(join(this.secretsDir, secretName));
      const trimmed = raw.trim();
      if (!trimmed) {
        throw new Error("Empty secret file");
      }
      return trimmed;
    } catch {
      throw new Error(
        `Missing or unreadable required secret "${secretName}" in FileSecretsAdapter`
      );
    }
  }
}

export class CloudSecretsManagerAdapter implements SecretsProvider {
  public readonly adapterName = "cloud_secrets_manager" as const;
  private readonly fetchFromCloud: (secretId: string) => Promise<string>;
  private readonly cacheTtlMs: number;
  private readonly nowFn: () => number;
  private readonly cache = new Map<
    string,
    { value: string; expiresAtMs: number }
  >();

  constructor(options: {
    fetchFromCloud: (secretId: string) => Promise<string>;
    cacheTtlMs?: number;
    nowFn?: () => number;
  }) {
    this.fetchFromCloud = options.fetchFromCloud;
    this.cacheTtlMs = options.cacheTtlMs ?? 300_000;
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  public async getSecret(
    secretName: string,
    options?: { forceRefresh?: boolean }
  ): Promise<string> {
    const nowMs = this.nowFn();
    const cached = this.cache.get(secretName);
    if (!options?.forceRefresh && cached && cached.expiresAtMs > nowMs) {
      return cached.value;
    }

    let raw: string;
    try {
      raw = await this.fetchFromCloud(secretName);
    } catch {
      throw new Error(
        `CloudSecretsManagerAdapter failed to resolve secret "${secretName}"`
      );
    }

    if (!raw || raw.trim().length === 0) {
      throw new Error(
        `CloudSecretsManagerAdapter returned empty value for secret "${secretName}"`
      );
    }

    const trimmed = raw.trim();
    this.cache.set(secretName, {
      value: trimmed,
      expiresAtMs: nowMs + this.cacheTtlMs,
    });
    return trimmed;
  }
}

export async function bootstrapRequiredSecrets(
  provider: SecretsProvider,
  requiredSecretNames: string[]
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const name of requiredSecretNames) {
    resolved[name] = await provider.getSecret(name);
  }
  return resolved;
}
