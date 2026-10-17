export type OnChainTrustTier =
  | "single_source"
  | "corroborated"
  | "decentralized";

export interface ProvenanceOnChainReadingV2 {
  version: 2;
  feedId: string;
  canonicalMinorUnits: bigint;
  sourceTimestampSec: number;
  publishTimestampSec: number;
  trustTier: OnChainTrustTier;
  agreeingSourceCount: number;
  expectedSourceCount: number;
  decisionRefHex: string; // 16 hex chars (8 bytes)
}

export interface LegacyOnChainReadingV1 {
  version: 1;
  feedId: string;
  canonicalMinorUnits: bigint;
}

export type DecodedOnChainReading =
  | ProvenanceOnChainReadingV2
  | LegacyOnChainReadingV1;

const TRUST_TIER_TO_CODE: Record<OnChainTrustTier, number> = {
  single_source: 0,
  corroborated: 1,
  decentralized: 2,
};

const CODE_TO_TRUST_TIER: Record<number, OnChainTrustTier> = {
  0: "single_source",
  1: "corroborated",
  2: "decentralized",
};

export class ProvenanceReadingCodec {
  public static readonly MAX_ONCHAIN_PROVENANCE_BYTES = 48;
  public static readonly MAX_FEED_ID_BYTES = 16;

  public static encodeV2(reading: Omit<ProvenanceOnChainReadingV2, "version">): Buffer {
    const feedBuf = Buffer.from(reading.feedId, "utf8");
    if (feedBuf.length === 0 || feedBuf.length > this.MAX_FEED_ID_BYTES) {
      throw new Error(
        `FIELD_OVERFLOW: feedId length (${feedBuf.length} bytes) must be within 1..${this.MAX_FEED_ID_BYTES}`
      );
    }

    if (
      reading.canonicalMinorUnits < 0n ||
      reading.canonicalMinorUnits > 0xffff_ffff_ffff_ffffn
    ) {
      throw new Error(
        "FIELD_OVERFLOW: canonicalMinorUnits must fit in unsigned 64-bit integer"
      );
    }

    if (
      !Number.isInteger(reading.sourceTimestampSec) ||
      reading.sourceTimestampSec < 0 ||
      reading.sourceTimestampSec > 0xffff_ffff
    ) {
      throw new Error(
        "FIELD_OVERFLOW: sourceTimestampSec must fit in unsigned 32-bit integer"
      );
    }

    if (
      !Number.isInteger(reading.publishTimestampSec) ||
      reading.publishTimestampSec < 0 ||
      reading.publishTimestampSec > 0xffff_ffff
    ) {
      throw new Error(
        "FIELD_OVERFLOW: publishTimestampSec must fit in unsigned 32-bit integer"
      );
    }

    const tierCode = TRUST_TIER_TO_CODE[reading.trustTier];
    if (tierCode === undefined) {
      throw new Error("FIELD_OVERFLOW: trustTier is invalid");
    }

    if (
      !Number.isInteger(reading.agreeingSourceCount) ||
      reading.agreeingSourceCount < 0 ||
      reading.agreeingSourceCount > 255
    ) {
      throw new Error(
        "FIELD_OVERFLOW: agreeingSourceCount must fit in uint8 (0..255)"
      );
    }

    if (
      !Number.isInteger(reading.expectedSourceCount) ||
      reading.expectedSourceCount < 1 ||
      reading.expectedSourceCount > 255 ||
      reading.agreeingSourceCount > reading.expectedSourceCount
    ) {
      throw new Error(
        "FIELD_OVERFLOW: expectedSourceCount must be in 1..255 and >= agreeingSourceCount"
      );
    }

    if (!/^[0-9a-fA-F]{16}$/.test(reading.decisionRefHex)) {
      throw new Error(
        "FIELD_OVERFLOW: decisionRefHex must be exactly 16 hex characters (8 bytes)"
      );
    }

    // Layout:
    // [0]: version = 0x02 (1B)
    // [1]: feedIdLen (1B)
    // [2..17]: feedId padded with 0x00 (16B)
    // [18..25]: canonicalMinorUnits uint64 BE (8B)
    // [26..29]: sourceTimestampSec uint32 BE (4B)
    // [30..33]: publishTimestampSec uint32 BE (4B)
    // [34]: trustTierCode (1B)
    // [35]: agreeingSourceCount (1B)
    // [36]: expectedSourceCount (1B)
    // [37..44]: decisionRef 8 bytes (8B)
    // Total = 45 bytes <= MAX_ONCHAIN_PROVENANCE_BYTES (48 bytes)
    const buf = Buffer.alloc(45);
    buf.writeUInt8(2, 0);
    buf.writeUInt8(feedBuf.length, 1);
    feedBuf.copy(buf, 2);
    buf.writeBigUInt64BE(reading.canonicalMinorUnits, 18);
    buf.writeUInt32BE(reading.sourceTimestampSec, 26);
    buf.writeUInt32BE(reading.publishTimestampSec, 30);
    buf.writeUInt8(tierCode, 34);
    buf.writeUInt8(reading.agreeingSourceCount, 35);
    buf.writeUInt8(reading.expectedSourceCount, 36);
    Buffer.from(reading.decisionRefHex.toLowerCase(), "hex").copy(buf, 37);

    if (buf.length > this.MAX_ONCHAIN_PROVENANCE_BYTES) {
      throw new Error("FIELD_OVERFLOW: encoded payload exceeds budget");
    }

    return buf;
  }

  public static encodeLegacyV1(reading: {
    feedId: string;
    canonicalMinorUnits: bigint;
  }): Buffer {
    const feedBuf = Buffer.from(reading.feedId, "utf8");
    const buf = Buffer.alloc(2 + 16 + 8);
    buf.writeUInt8(1, 0);
    buf.writeUInt8(feedBuf.length, 1);
    feedBuf.copy(buf, 2);
    buf.writeBigUInt64BE(reading.canonicalMinorUnits, 18);
    return buf;
  }

  public static decode(buf: Buffer): DecodedOnChainReading {
    if (buf.length < 2) {
      throw new Error("INVALID_PAYLOAD: Buffer too short");
    }
    const version = buf.readUInt8(0);
    const feedLen = buf.readUInt8(1);

    if (version === 1) {
      if (buf.length !== 26 || feedLen > 16) {
        throw new Error("INVALID_V1_PAYLOAD");
      }
      return {
        version: 1,
        feedId: buf.subarray(2, 2 + feedLen).toString("utf8"),
        canonicalMinorUnits: buf.readBigUInt64BE(18),
      };
    }

    if (version === 2) {
      if (buf.length !== 45 || feedLen > 16) {
        throw new Error("INVALID_V2_PAYLOAD");
      }
      const tierCode = buf.readUInt8(34);
      const trustTier = CODE_TO_TRUST_TIER[tierCode];
      if (!trustTier) {
        throw new Error("INVALID_TRUST_TIER_CODE");
      }
      return {
        version: 2,
        feedId: buf.subarray(2, 2 + feedLen).toString("utf8"),
        canonicalMinorUnits: buf.readBigUInt64BE(18),
        sourceTimestampSec: buf.readUInt32BE(26),
        publishTimestampSec: buf.readUInt32BE(30),
        trustTier,
        agreeingSourceCount: buf.readUInt8(35),
        expectedSourceCount: buf.readUInt8(36),
        decisionRefHex: buf.subarray(37, 45).toString("hex"),
      };
    }

    throw new Error(`UNSUPPORTED_READING_VERSION: ${version}`);
  }
}
