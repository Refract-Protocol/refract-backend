import { Injectable } from "@nestjs/common";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { OracleReading } from "./oracle-reading";

const PRIVATE_KEY_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface AttestationInput {
  adapter: string;
  schemaVersion: number;
  digest: string;
  eligible?: boolean;
}

export interface OracleDecisionPayload {
  version: 1;
  keyId: string;
  feed: string;
  decision: {
    value: number;
    threshold: number;
    severity: OracleReading["severity"];
  };
  inputs: AttestationInput[];
  quorum: {
    required: number;
    observed: number;
    outcome: "met" | "not_met";
  };
  evidenceRoot: string;
  timestamp: string;
}

export interface OracleVerificationKey {
  keyId: string;
  algorithm: "Ed25519";
  publicKey: string;
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

@Injectable()
export class OracleAttestationService {
  private readonly privateKey: ReturnType<typeof createPrivateKey> | null;
  private readonly verificationKey: OracleVerificationKey | null;

  constructor(seed = process.env.ORACLE_ATTESTATION_PRIVATE_KEY?.trim() ?? "") {
    if (!seed) {
      this.privateKey = null;
      this.verificationKey = null;
      return;
    }

    const seedBytes = Buffer.from(seed, "base64");
    if (seedBytes.length !== 32 || seedBytes.toString("base64") !== seed) {
      throw new Error("ORACLE_ATTESTATION_PRIVATE_KEY must be a base64-encoded 32-byte Ed25519 seed");
    }

    this.privateKey = createPrivateKey({
      key: Buffer.concat([PRIVATE_KEY_PREFIX, seedBytes]),
      format: "der",
      type: "pkcs8",
    });
    const publicDer = createPublicKey(this.privateKey).export({ format: "der", type: "spki" });
    const publicBytes = Buffer.from(publicDer).subarray(-32);
    this.verificationKey = {
      keyId: sha256(publicBytes.toString("base64url")).slice(0, 16),
      algorithm: "Ed25519",
      publicKey: base64Url(publicBytes),
    };
  }

  getVerificationKeys(): OracleVerificationKey[] {
    return this.verificationKey ? [this.verificationKey] : [];
  }

  createAttestation(
    reading: OracleReading,
    inputs: AttestationInput[],
    timestamp = new Date().toISOString(),
  ): { token: string; evidenceRoot: string } {
    if (!this.privateKey || !this.verificationKey) {
      throw new Error("Oracle attestations are not configured; set ORACLE_ATTESTATION_PRIVATE_KEY");
    }

    const orderedInputs = [...inputs].sort((left, right) =>
      `${left.adapter}:${left.digest}`.localeCompare(`${right.adapter}:${right.digest}`),
    );
    const evidenceRoot = sha256(canonicalJson(orderedInputs));
    const payload: OracleDecisionPayload = {
      version: 1,
      keyId: this.verificationKey.keyId,
      feed: reading.coverageType,
      decision: {
        value: reading.value,
        threshold: reading.threshold,
        severity: reading.severity,
      },
      inputs: orderedInputs,
      quorum: {
        required: 1,
        observed: orderedInputs.filter((input) => input.eligible !== false).length,
        outcome: orderedInputs.some((input) => input.eligible !== false) ? "met" : "not_met",
      },
      evidenceRoot,
      timestamp,
    };
    const encodedPayload = base64Url(Buffer.from(canonicalJson(payload)));
    const signature = base64Url(sign(null, Buffer.from(encodedPayload), this.privateKey));
    return { token: `oa1.${encodedPayload}.${signature}`, evidenceRoot };
  }
}

export function decodeOracleAttestation(token: string): OracleDecisionPayload {
  const [version, encodedPayload, signature, extra] = token.split(".");
  if (version !== "oa1" || !encodedPayload || !signature || extra !== undefined) {
    throw new Error("Invalid compact oracle attestation format");
  }
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as OracleDecisionPayload;
  if (payload.version !== 1 || payload.keyId.length === 0) {
    throw new Error("Unsupported oracle attestation payload");
  }
  return payload;
}
