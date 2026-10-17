import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type EvidenceAccessRole = "writer" | "analytics_reader" | "audited_operator";

export interface EncryptedEvidenceRecord {
  recordId: string;
  feedId: string;
  keyVersion: string;
  ivHex: string;
  authTagHex: string;
  ciphertextHex: string;
  plaintextSha256: string;
  rowIntegrityHash: string;
}

export class EvidenceAtRestEncryptor {
  private readonly keys = new Map<string, Buffer>();
  private activeKeyVersion: string;

  constructor(initialKeyVersion: string, keyBytes: Buffer) {
    if (keyBytes.length !== 32) {
      throw new Error("AES-256-GCM requires a 32-byte key");
    }
    this.keys.set(initialKeyVersion, Buffer.from(keyBytes));
    this.activeKeyVersion = initialKeyVersion;
  }

  public rotateKey(newKeyVersion: string, keyBytes: Buffer): void {
    if (keyBytes.length !== 32) {
      throw new Error("AES-256-GCM requires a 32-byte key");
    }
    this.keys.set(newKeyVersion, Buffer.from(keyBytes));
    this.activeKeyVersion = newKeyVersion;
  }

  private computeRowIntegrityHash(params: {
    recordId: string;
    feedId: string;
    keyVersion: string;
    ivHex: string;
    authTagHex: string;
    ciphertextHex: string;
    plaintextSha256: string;
  }): string {
    return createHash("sha256")
      .update(
        `${params.recordId}|${params.feedId}|${params.keyVersion}|${params.ivHex}|${params.authTagHex}|${params.ciphertextHex}|${params.plaintextSha256}`
      )
      .digest("hex");
  }

  public encryptRecord(params: {
    role: EvidenceAccessRole;
    recordId: string;
    feedId: string;
    rawPayloadJson: string;
  }): EncryptedEvidenceRecord {
    if (params.role !== "writer" && params.role !== "audited_operator") {
      throw new Error(`Role '${params.role}' is not authorized to write encrypted evidence`);
    }

    const key = this.keys.get(this.activeKeyVersion)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
      cipher.update(params.rawPayloadJson, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    const plaintextSha256 = createHash("sha256").update(params.rawPayloadJson, "utf8").digest("hex");

    const base = {
      recordId: params.recordId,
      feedId: params.feedId,
      keyVersion: this.activeKeyVersion,
      ivHex: iv.toString("hex"),
      authTagHex: authTag.toString("hex"),
      ciphertextHex: encrypted.toString("hex"),
      plaintextSha256,
    };

    return {
      ...base,
      rowIntegrityHash: this.computeRowIntegrityHash(base),
    };
  }

  public readMetadata(record: EncryptedEvidenceRecord): {
    recordId: string;
    feedId: string;
    plaintextSha256: string;
    integrityValid: boolean;
  } {
    const expectedRowHash = this.computeRowIntegrityHash(record);
    return {
      recordId: record.recordId,
      feedId: record.feedId,
      plaintextSha256: record.plaintextSha256,
      integrityValid: expectedRowHash === record.rowIntegrityHash,
    };
  }

  public decryptPayload(params: {
    role: EvidenceAccessRole;
    record: EncryptedEvidenceRecord;
  }): string {
    if (params.role !== "audited_operator") {
      throw new Error(`Role '${params.role}' is not permitted to decrypt raw evidence payloads`);
    }

    const expectedRowHash = this.computeRowIntegrityHash(params.record);
    if (expectedRowHash !== params.record.rowIntegrityHash) {
      throw new Error(`Tamper detected on evidence record '${params.record.recordId}'`);
    }

    const key = this.keys.get(params.record.keyVersion);
    if (!key) {
      throw new Error(`Encryption key version '${params.record.keyVersion}' not found`);
    }

    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(params.record.ivHex, "hex")
    );
    decipher.setAuthTag(Buffer.from(params.record.authTagHex, "hex"));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(params.record.ciphertextHex, "hex")),
      decipher.final(),
    ]).toString("utf8");

    const actualPlaintextHash = createHash("sha256").update(decrypted, "utf8").digest("hex");
    if (actualPlaintextHash !== params.record.plaintextSha256) {
      throw new Error("Decrypted payload hash mismatch");
    }

    return decrypted;
  }
}
