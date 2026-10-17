import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProvenanceReadingCodec } from "./provenanceReadingCodec.ts";

describe("Encode Consensus Provenance in Published On-Chain Readings (#250)", () => {
  it("round-trips v2 provenance readings within the 48-byte Soroban size budget and decodes legacy v1 payloads", () => {
    const encodedV2 = ProvenanceReadingCodec.encodeV2({
      feedId: "USDC/USD",
      canonicalMinorUnits: 99_985_000n,
      sourceTimestampSec: 1_700_000_000,
      publishTimestampSec: 1_700_000_005,
      trustTier: "corroborated",
      agreeingSourceCount: 3,
      expectedSourceCount: 3,
      decisionRefHex: "a1b2c3d4e5f60718",
    });

    assert.ok(
      encodedV2.length <= ProvenanceReadingCodec.MAX_ONCHAIN_PROVENANCE_BYTES
    );

    const decodedV2 = ProvenanceReadingCodec.decode(encodedV2);
    assert.equal(decodedV2.version, 2);
    if (decodedV2.version === 2) {
      assert.equal(decodedV2.feedId, "USDC/USD");
      assert.equal(decodedV2.canonicalMinorUnits, 99_985_000n);
      assert.equal(decodedV2.trustTier, "corroborated");
      assert.equal(decodedV2.agreeingSourceCount, 3);
      assert.equal(decodedV2.expectedSourceCount, 3);
      assert.equal(decodedV2.decisionRefHex, "a1b2c3d4e5f60718");
    }

    // Legacy v1 backward-compatible decoding
    const encodedV1 = ProvenanceReadingCodec.encodeLegacyV1({
      feedId: "XLM/USD",
      canonicalMinorUnits: 12_000_000n,
    });
    const decodedV1 = ProvenanceReadingCodec.decode(encodedV1);
    assert.equal(decodedV1.version, 1);
    assert.equal(decodedV1.feedId, "XLM/USD");
    assert.equal(decodedV1.canonicalMinorUnits, 12_000_000n);
  });

  it("rejects oversized fields with a typed FIELD_OVERFLOW error naming the offending field rather than truncating", () => {
    assert.throws(
      () =>
        ProvenanceReadingCodec.encodeV2({
          feedId: "THIS_FEED_ID_IS_WAY_TOO_LONG_FOR_ONCHAIN_ENCODING",
          canonicalMinorUnits: 100n,
          sourceTimestampSec: 1_700_000_000,
          publishTimestampSec: 1_700_000_001,
          trustTier: "single_source",
          agreeingSourceCount: 1,
          expectedSourceCount: 1,
          decisionRefHex: "0102030405060708",
        }),
      /FIELD_OVERFLOW: feedId/
    );

    assert.throws(
      () =>
        ProvenanceReadingCodec.encodeV2({
          feedId: "USDC/USD",
          canonicalMinorUnits: 100n,
          sourceTimestampSec: 1_700_000_000,
          publishTimestampSec: 1_700_000_001,
          trustTier: "corroborated",
          agreeingSourceCount: 4,
          expectedSourceCount: 3, // agreeing > expected
          decisionRefHex: "0102030405060708",
        }),
      /FIELD_OVERFLOW: expectedSourceCount/
    );
  });
});
