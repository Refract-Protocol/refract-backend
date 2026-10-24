import { createHash, createPublicKey, verify } from "node:crypto";
import {
  decodeOracleAttestation,
  OracleAttestationService,
} from "./oracle-attestation.service";
import { OracleReading } from "./oracle-reading";

const reading: OracleReading = {
  coverageType: "StablecoinDepeg",
  type: "oracle_update",
  value: 0.99,
  threshold: 0.95,
  severity: "low",
  message: "USDC price [CoinGecko]",
};

describe("OracleAttestationService", () => {
  it("signs a compact decision with its evidence root and public verification key", () => {
    const service = new OracleAttestationService(Buffer.alloc(32, 9).toString("base64"));
    const input = {
      adapter: "coingecko",
      schemaVersion: 1,
      digest: "a".repeat(64),
    };
    const { token, evidenceRoot } = service.createAttestation(reading, [input], "2026-10-20T00:00:00.000Z");
    const [prefix, encodedPayload, encodedSignature] = token.split(".");
    const payload = decodeOracleAttestation(token);
    const publicKey = service.getVerificationKeys()[0];
    const publicBytes = Buffer.from(publicKey.publicKey, "base64url");
    const keyId = createHash("sha256").update(publicKey.publicKey).digest("hex").slice(0, 16);
    const verificationKey = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicBytes]),
      format: "der",
      type: "spki",
    });

    expect(prefix).toBe("oa1");
    expect(payload.feed).toBe("StablecoinDepeg");
    expect(payload.inputs).toEqual([input]);
    expect(payload.quorum).toEqual({ required: 1, observed: 1, outcome: "met" });
    expect(payload.evidenceRoot).toBe(evidenceRoot);
    expect(payload.timestamp).toBe("2026-10-20T00:00:00.000Z");
    expect(payload.keyId).toBe(keyId);
    expect(verify(null, Buffer.from(encodedPayload), verificationKey, Buffer.from(encodedSignature, "base64url"))).toBe(true);
  });

  it("signs fail-safe readings with a not-met quorum and rejects missing signing keys", () => {
    const service = new OracleAttestationService(Buffer.alloc(32, 3).toString("base64"));
    const result = service.createAttestation(reading, [], "2026-10-20T00:00:00.000Z");

    expect(decodeOracleAttestation(result.token).quorum).toEqual({
      required: 1,
      observed: 0,
      outcome: "not_met",
    });
    expect(() => new OracleAttestationService().createAttestation(reading, [])).toThrow(
      "ORACLE_ATTESTATION_PRIVATE_KEY",
    );
  });
});
