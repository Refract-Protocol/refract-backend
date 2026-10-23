import { Injectable, Logger } from "@nestjs/common";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { createHash } from "crypto";
import { readFileSync, statSync } from "fs";
import { NETWORK_PASSPHRASES } from "./stellar-config.validator";

export interface KeyringEntry {
  id: string;
  network: string;
  active: boolean;
  publicKey: string;
}

export interface KeySignature {
  keyId: string;
  publicKey: string;
  /** base64 ed25519 signature over sha256(payload) */
  signature: string;
}

export class QuorumNotMetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuorumNotMetError";
  }
}

interface LoadedKey extends KeyringEntry {
  keypair: Keypair;
}

/**
 * Keystore-backed relayer keyring. Key material comes from a JSON file
 * (ORACLE_RELAYER_KEYSTORE_PATH, mounted from a secret manager) shaped as
 * an object with a `keys` array of `{ id, secret, network, active }` entries;
 * ORACLE_RELAYER_SECRET is accepted only as a single dev key. The file is
 * re-read when its mtime changes, so rotation needs no restart. Secrets are
 * never logged (only key ids and public keys) and never leave this class:
 * callers use signFor()/signWith().
 *
 * Threshold policy: ORACLE_QUORUM_PAYOUT_THRESHOLD (default 2) applies to
 * payout-triggering feeds (every coverage type unless listed in
 * ORACLE_QUORUM_NON_PAYOUT_FEEDS), ORACLE_QUORUM_DEFAULT_THRESHOLD (default 1)
 * to the rest, and ORACLE_QUORUM_THRESHOLDS="Feed=N,..." overrides per feed.
 */
@Injectable()
export class RelayerKeyring {
  private readonly logger = new Logger(RelayerKeyring.name);
  private keys: LoadedKey[] = [];
  private mtimeMs = 0;
  private generation = 0;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    this.reload();
  }

  /** Bumps whenever the active key set changes; used to detect mid-flight rotation. */
  getGeneration(): number {
    this.refreshIfChanged();
    return this.generation;
  }

  reload(): void {
    const before = this.activeIds().join(",");
    this.keys = this.loadKeys();
    if (before !== this.activeIds().join(",")) {
      this.generation++;
      this.logger.log(
        `Relayer keyring loaded: ${this.keys
          .map((k) => `${k.id}(${k.publicKey},${k.active ? "active" : "revoked"})`)
          .join(", ")}`
      );
    }
  }

  list(): KeyringEntry[] {
    this.refreshIfChanged();
    return this.keys.map(({ id, network, active, publicKey }) => ({ id, network, active, publicKey }));
  }

  activeKeys(network: string): KeyringEntry[] {
    return this.list().filter((k) => k.active && k.network === network.toLowerCase());
  }

  isActive(keyId: string): boolean {
    this.refreshIfChanged();
    return this.keys.some((k) => k.id === keyId && k.active);
  }

  requiredSignatures(feed: string): number {
    for (const pair of (this.env.ORACLE_QUORUM_THRESHOLDS ?? "").split(",")) {
      const [name, n] = pair.split("=").map((s) => s.trim());
      if (name === feed && Number.isInteger(Number(n)) && Number(n) >= 1) return Number(n);
    }
    const nonPayout = (this.env.ORACLE_QUORUM_NON_PAYOUT_FEEDS ?? "").split(",").map((s) => s.trim());
    const isNonPayout = nonPayout.includes(feed);
    const fallback = isNonPayout ? 1 : 2;
    const raw = isNonPayout ? this.env.ORACLE_QUORUM_DEFAULT_THRESHOLD : this.env.ORACLE_QUORUM_PAYOUT_THRESHOLD;
    const parsed = Number(raw ?? fallback);
    return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
  }

  /** Fail-fast: every feed's threshold must be satisfiable by active keys on `network`. */
  assertThresholds(feeds: string[], network: string): void {
    const available = this.activeKeys(network).length;
    for (const feed of feeds) {
      const required = this.requiredSignatures(feed);
      if (required > available) {
        throw new Error(
          `Oracle quorum threshold ${required} for feed ${feed} exceeds ${available} active relayer key(s) on ${network}`
        );
      }
    }
  }

  /** Signs sha256(payload) with one specific key. Throws if the key is unknown or revoked. */
  signWith(keyId: string, payload: Buffer): KeySignature {
    this.refreshIfChanged();
    const key = this.keys.find((k) => k.id === keyId && k.active);
    if (!key) throw new Error(`Relayer key ${keyId} is not active`);
    return {
      keyId: key.id,
      publicKey: key.publicKey,
      signature: key.keypair.sign(createHash("sha256").update(payload).digest()).toString("base64"),
    };
  }

  /**
   * Collects signatures from distinct active keys on `network` until the
   * feed's threshold is met. A failing signer is skipped; if the threshold
   * cannot be met a QuorumNotMetError is thrown and no partial set is returned.
   */
  signFor(feed: string, payload: Buffer, network: string): KeySignature[] {
    const required = this.requiredSignatures(feed);
    const signatures: KeySignature[] = [];
    const failures: string[] = [];
    for (const key of this.activeKeys(network)) {
      if (signatures.length >= required) break;
      try {
        signatures.push(this.signWith(key.id, payload));
      } catch {
        failures.push(key.id);
      }
    }
    if (signatures.length < required) {
      throw new QuorumNotMetError(
        `Quorum not met for ${feed}: ${signatures.length}/${required} signatures` +
          (failures.length ? ` (failed keys: ${failures.join(", ")})` : "")
      );
    }
    return signatures;
  }

  private activeIds(): string[] {
    return this.keys.filter((k) => k.active).map((k) => k.id);
  }

  private refreshIfChanged(): void {
    const path = this.env.ORACLE_RELAYER_KEYSTORE_PATH?.trim();
    if (!path) return;
    try {
      if (statSync(path).mtimeMs !== this.mtimeMs) this.reload();
    } catch (err) {
      this.logger.warn(`Keystore unreadable, keeping previous keys: ${err instanceof Error ? err.name : "error"}`);
    }
  }

  private loadKeys(): LoadedKey[] {
    const path = this.env.ORACLE_RELAYER_KEYSTORE_PATH?.trim();
    const defaultNetwork = (this.env.STELLAR_NETWORK ?? "testnet").trim().toLowerCase();
    const raw: Array<{ id?: string; secret?: string; network?: string; active?: boolean }> = [];
    if (path) {
      try {
        this.mtimeMs = statSync(path).mtimeMs;
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        raw.push(...(Array.isArray(parsed?.keys) ? parsed.keys : []));
      } catch (err) {
        // Never echo file contents; keep prior keys on a bad rotation file.
        this.logger.error(`Failed to load relayer keystore: ${err instanceof Error ? err.name : "error"}`);
        return this.keys;
      }
    } else if (this.env.ORACLE_RELAYER_SECRET?.trim()) {
      raw.push({ id: "dev-default", secret: this.env.ORACLE_RELAYER_SECRET.trim() });
    }
    const seen = new Set<string>();
    const loaded: LoadedKey[] = [];
    for (const entry of raw) {
      const id = entry.id?.trim();
      const network = (entry.network ?? defaultNetwork).trim().toLowerCase();
      if (!id || !entry.secret || !StrKey.isValidEd25519SecretSeed(entry.secret)) {
        this.logger.error(`Skipping malformed keystore entry${id ? ` "${id}"` : ""}`);
        continue;
      }
      if (seen.has(id) || !NETWORK_PASSPHRASES[network]) {
        this.logger.error(`Skipping keystore entry "${id}": duplicate id or unknown network`);
        continue;
      }
      seen.add(id);
      const keypair = Keypair.fromSecret(entry.secret);
      loaded.push({ id, network, active: entry.active !== false, publicKey: keypair.publicKey(), keypair });
    }
    return loaded;
  }
}
