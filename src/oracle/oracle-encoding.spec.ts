import * as fs from "fs";
import * as path from "path";
import fc from "fast-check";
import { scValToNative } from "@stellar/stellar-sdk";
import { DEFAULT_CONSENSUS_POLICY, evaluateConsensus } from "./consensus/consensus";
import {
  PROVENANCE_VERSION,
  ProvenanceEncodingError,
  ReadingProvenance,
  TrustTier,
  buildUpdateReadingArgs,
  coverageTypeToU32,
  encodeReadingForChain,
  packProvenance,
  parseFixedDecimal,
  provenanceFromDecision,
  scaleOracleValue,
  unpackProvenance,
} from "./oracle-encoding";
import { OracleReading } from "./oracle-reading";

const FIXTURES = path.join(__dirname, "../stellar/xdr-fixtures");

function readFixture(name: string): string {
  const raw = fs.readFileSync(path.join(FIXTURES, name), "utf8");
  return raw
    .split("\n")
    .filter((l) => l && !l.startsWith("//"))
    .join("")
    .trim();
}

const SAMPLE: ReadingProvenance = {
  trustTier: TrustTier.Corroborated,
  agreeingSources: 3,
  decisionId: "0123456789abcdef",
  sourceTimestamp: 1_700_000_000,
};

describe("value scaling", () => {
  it("scales each coverage type deterministically", () => {
    expect(scaleOracleValue("StablecoinDepeg", 0.9998)).toBe(9_998_000n);
    expect(scaleOracleValue("MarketCrash", -30.12)).toBe(-3012n);
    expect(scaleOracleValue("LiquidationShield", 0.42)).toBe(4200n);
    expect(scaleOracleValue("SmartContractRisk", -50)).toBe(-5000n);
    expect(scaleOracleValue("FlightDelay", 247.4)).toBe(247n);
  });

  it("maps coverage type names to u32 discriminants", () => {
    expect(coverageTypeToU32("FlightDelay")).toBe(4);
    expect(() => coverageTypeToU32("Nope")).toThrow();
  });
});

describe("provenance packing", () => {
  it("matches the documented bit layout", () => {
    // version=1 | tier=2 | count=0x03 | reserved=0x00 | ts=0x006553f100 | id
    expect(packProvenance(SAMPLE)).toBe(0x1203_00_006553f100_0123456789abcdefn);
    expect(PROVENANCE_VERSION).toBe(1);
  });

  it("round-trips every valid provenance", () => {
    const tierAndCount = fc.oneof(
      fc.constant({ trustTier: TrustTier.SingleSource, agreeingSources: 1 }),
      fc.integer({ min: 2, max: 255 }).map((n) => ({ trustTier: TrustTier.Corroborated, agreeingSources: n })),
      fc.integer({ min: 3, max: 255 }).map((n) => ({ trustTier: TrustTier.Unanimous, agreeingSources: n }))
    );
    fc.assert(
      fc.property(
        tierAndCount,
        fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
        fc.integer({ min: 0, max: 2 ** 40 - 1 }),
        (tc, id, ts) => {
          const p: ReadingProvenance = { ...tc, decisionId: id.toString(16).padStart(16, "0"), sourceTimestamp: ts };
          const packed = packProvenance(p);
          expect(packed).toBeGreaterThanOrEqual(0n);
          expect(packed).toBeLessThan(1n << 128n);
          expect(unpackProvenance(packed)).toEqual(p);
        }
      )
    );
  });

  it.each<[string, Partial<ReadingProvenance>]>([
    ["unverified tier", { trustTier: TrustTier.Unverified }],
    ["unknown tier", { trustTier: 9 as TrustTier }],
    ["single source with two sources", { trustTier: TrustTier.SingleSource, agreeingSources: 2 }],
    ["corroborated with one source", { trustTier: TrustTier.Corroborated, agreeingSources: 1 }],
    ["unanimous with two sources", { trustTier: TrustTier.Unanimous, agreeingSources: 2 }],
    ["source count over 255", { agreeingSources: 256 }],
    ["fractional source count", { agreeingSources: 2.5 }],
    ["short decision id", { decisionId: "abc" }],
    ["upper-case decision id", { decisionId: "0123456789ABCDEF" }],
    ["negative timestamp", { sourceTimestamp: -1 }],
    ["timestamp in milliseconds", { sourceTimestamp: 1_700_000_000_000 * 1000 }],
  ])("rejects %s", (_label, override) => {
    expect(() => packProvenance({ ...SAMPLE, ...override })).toThrow(ProvenanceEncodingError);
  });

  it("rejects unknown versions, set reserved bits and out-of-range input when unpacking", () => {
    const good = packProvenance(SAMPLE);
    expect(() => unpackProvenance(0n)).toThrow(/version 0/);
    expect(() => unpackProvenance(good | (1n << 104n))).toThrow(/Reserved/);
    expect(() => unpackProvenance((good & ~(0xfn << 124n)) | (2n << 124n))).toThrow(/version 2/);
    expect(() => unpackProvenance(-1n)).toThrow(ProvenanceEncodingError);
    expect(() => unpackProvenance(1n << 128n)).toThrow(ProvenanceEncodingError);
  });
});

describe("provenanceFromDecision", () => {
  const NOW = 1_700_000_000_999;

  it("carries tier, agreeing count, decision id and floored timestamp", () => {
    const decision = evaluateConsensus(
      [
        { sourceId: "a", value: 1, weight: 1, observedAt: NOW - 1_500 },
        { sourceId: "b", value: 1, weight: 1, observedAt: NOW },
        { sourceId: "evil", value: 9, weight: 1, observedAt: NOW },
      ],
      { ...DEFAULT_CONSENSUS_POLICY, quorumRatio: 0.5 },
      NOW
    );
    const p = provenanceFromDecision(decision);
    expect(p).toEqual({
      trustTier: TrustTier.Corroborated,
      agreeingSources: 2,
      decisionId: decision.decisionId,
      sourceTimestamp: 1_699_999_999,
    });
    expect(unpackProvenance(packProvenance(p))).toEqual(p);
  });

  it("refuses decisions that did not reach consensus", () => {
    const decision = evaluateConsensus([], DEFAULT_CONSENSUS_POLICY, NOW);
    expect(() => provenanceFromDecision(decision)).toThrow(/no_valid_sources/);
  });
});

describe("on-chain encoding", () => {
  it("builds update_reading(u32, i128, u128) arguments", () => {
    const encoded = encodeReadingForChain("StablecoinDepeg", 0.9998, SAMPLE);
    const args = buildUpdateReadingArgs(encoded);

    expect(args.map((a) => a.switch().name)).toEqual(["scvU32", "scvI128", "scvU128"]);
    expect(args.map((a) => scValToNative(a))).toEqual([0, 9_998_000n, packProvenance(SAMPLE)]);
    expect(unpackProvenance(scValToNative(args[2]) as bigint)).toEqual(SAMPLE);
  });

  it("matches the golden XDR fixture for the provenance argument", () => {
    const [, , provenance] = buildUpdateReadingArgs(encodeReadingForChain("StablecoinDepeg", 0.9998, SAMPLE));
    expect(provenance.toXDR("base64")).toBe(readFixture("oracle-update-reading-provenance.xdr.b64"));
  });

  it("keeps readings with provenance JSON-serialisable", () => {
    const reading: OracleReading = {
      coverageType: "StablecoinDepeg",
      type: "oracle_update",
      value: 0.9998,
      threshold: 0.95,
      severity: "low",
      message: "ok",
      provenance: SAMPLE,
    };
    expect(JSON.parse(JSON.stringify(reading))).toEqual(reading);
  });
});

describe("parseFixedDecimal", () => {
  it.each([
    ["0.5", 2, 50n],
    ["-0.5", 2, -50n],
    ["5", 2, 500n],
  ])("parses %s at scale %i", (input, scale, expected) => {
    expect(parseFixedDecimal(input, scale)).toBe(expected);
  });

  it.each([
    ["a lone decimal point", "."],
    ["a sign with no integer part", "-.5"],
    // As in fixed-point.spec.ts: "5." (a trailing dot, no fractional
    // digits) is also rejected by this same regex today, despite issue
    // #570 naming it as required-to-keep-working input — not asserted
    // here since no existing behaviour or test backs that claim.
  ])("rejects %s", (_label, input) => {
    expect(() => parseFixedDecimal(input, 2)).toThrow();
  });
});
