import * as fs from "fs";
import * as path from "path";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  COVERAGE_TYPE_VARIANTS,
  FIXTURE_MISMATCH_HINT,
  TRIGGER_THRESHOLDS,
  TRIGGER_THRESHOLD_UNITS,
  buildPolicyParamsScVal,
  buildPolicyParamsScValInferred,
  encodeOraclePublishArgs,
  encodeProcessClaimArg,
  encodeProvideCapitalArgs,
  encodeWithdrawCapitalArgs,
  policyParamsToXdrBase64,
} from "./scval-encoders";

const FIXTURES = path.join(__dirname, "xdr-fixtures");

function readFixture(name: string): string {
  const raw = fs.readFileSync(path.join(FIXTURES, name), "utf8");
  const lines = raw.split("\n").filter((l) => l && !l.startsWith("//"));
  return lines.join("").trim();
}

const REPRESENTATIVE = [
  { coverageType: 0, coverageAmount: 10_000n * 10_000_000n, durationDays: 30 },
  { coverageType: 1, coverageAmount: 25_000n * 10_000_000n, durationDays: 90 },
  { coverageType: 2, coverageAmount: 50_000n * 10_000_000n, durationDays: 180 },
  { coverageType: 3, coverageAmount: 2n ** 60n, durationDays: 365 },
  { coverageType: 4, coverageAmount: 1_000n * 10_000_000n, durationDays: 7 },
] as const;

describe("scval-encoders golden XDR suite", () => {
  describe("buildPolicyParamsScVal", () => {
    it.each(REPRESENTATIVE)(
      "matches golden fixture byte-for-byte for coverageType $coverageType",
      ({ coverageType, coverageAmount, durationDays }) => {
        const name = COVERAGE_TYPE_VARIANTS[coverageType];
        const expected = readFixture(`policy-params-${name}.xdr.b64`);
        const actual = policyParamsToXdrBase64({
          coverageType,
          coverageAmount,
          durationDays,
          triggerThreshold: TRIGGER_THRESHOLDS[coverageType],
        });
        if (actual !== expected) {
          throw new Error(`${FIXTURE_MISMATCH_HINT}\nexpected=${expected}\nactual=${actual}`);
        }
        expect(actual).toBe(expected);
      }
    );

    it("matches the large-i128 (2^60) fixture — amounts above 2^53 must stay exact", () => {
      const expected = readFixture("policy-params-large-i128.xdr.b64");
      const actual = policyParamsToXdrBase64({
        coverageType: 0,
        coverageAmount: 2n ** 60n,
        durationDays: 30,
        triggerThreshold: 500,
      });
      expect(actual).toBe(expected);
    });

    it("encodes map keys in alphabetical order with correct ScVal discriminants", () => {
      const sc = buildPolicyParamsScVal({
        coverageType: 0,
        coverageAmount: 1_000_000_0000n,
        durationDays: 30,
        triggerThreshold: 500,
      });
      expect(sc.switch().name).toBe("scvMap");
      const entries = sc.map()!;
      const keys = entries.map((e) => e.key().sym().toString());
      expect(keys).toEqual(["coverage_amount", "coverage_type", "duration_days", "trigger_threshold"]);

      expect(entries[0].val().switch().name).toBe("scvI128");
      expect(entries[1].val().switch().name).toBe("scvVec");
      const enumVec = entries[1].val().vec()!;
      expect(enumVec).toHaveLength(1);
      expect(enumVec[0].switch().name).toBe("scvSymbol");
      expect(enumVec[0].sym().toString()).toBe("StablecoinDepeg");
      expect(entries[2].val().switch().name).toBe("scvU32");
      expect(entries[3].val().switch().name).toBe("scvI128");
    });

    it("asserts TRIGGER_THRESHOLDS and their units per coverage type", () => {
      expect(TRIGGER_THRESHOLDS).toEqual([500, 3000, 500, 500, 120]);
      expect(TRIGGER_THRESHOLD_UNITS).toEqual(["bps", "bps", "inert", "inert", "minutes"]);
      expect(COVERAGE_TYPE_VARIANTS).toHaveLength(5);
      for (const name of COVERAGE_TYPE_VARIANTS) {
        expect(name.length).toBeLessThanOrEqual(32);
      }
      for (const field of ["coverage_amount", "coverage_type", "duration_days", "trigger_threshold"]) {
        expect(field.length).toBeLessThanOrEqual(32);
      }
    });

    it("NEGATIVE: inferred nativeToScVal (no { type }) differs from the golden encoding", () => {
      const params = {
        coverageType: 0 as number,
        coverageAmount: 2n ** 60n,
        durationDays: 30,
        triggerThreshold: 500,
      };
      const correct = policyParamsToXdrBase64(params);
      const wrong = buildPolicyParamsScValInferred(params).toXDR("base64");
      expect(wrong).not.toBe(correct);
      // Prove the suite would fail loudly against the golden fixture.
      const fixture = readFixture("policy-params-large-i128.xdr.b64");
      expect(wrong).not.toBe(fixture);
      expect(FIXTURE_MISMATCH_HINT).toMatch(/contract ABI changed|encoding regressed/);
    });
  });

  describe("encodeProcessClaimArg", () => {
    it("matches the single-u64 golden fixture", () => {
      expect(encodeProcessClaimArg(42n).toXDR("base64")).toBe(readFixture("process-claim-u64.xdr.b64"));
      expect(encodeProcessClaimArg(42n).switch().name).toBe("scvU64");
    });
  });

  describe("encodeProvideCapitalArgs / encodeWithdrawCapitalArgs", () => {
    const meta = JSON.parse(fs.readFileSync(path.join(FIXTURES, "provide-capital-meta.json"), "utf8")) as {
      providerPubkey: string;
      amount: string;
      shares: string;
    };

    it("matches provide_capital Address + i128 fixtures", () => {
      const [provider, amount] = encodeProvideCapitalArgs(meta.providerPubkey, BigInt(meta.amount));
      expect(provider.toXDR("base64")).toBe(readFixture("provide-capital-provider.xdr.b64"));
      expect(amount.toXDR("base64")).toBe(readFixture("provide-capital-amount.xdr.b64"));
      expect(amount.switch().name).toBe("scvI128");
    });

    it("matches withdraw_capital shares i128 fixture", () => {
      const [, shares] = encodeWithdrawCapitalArgs(meta.providerPubkey, BigInt(meta.shares));
      expect(shares.toXDR("base64")).toBe(readFixture("withdraw-capital-shares.xdr.b64"));
    });
  });

  describe("encodeOraclePublishArgs", () => {
    it("matches feed Symbol + i128 value + u64 timestamp fixtures", () => {
      const [feed, value, ts] = encodeOraclePublishArgs("USDC_USD", 9_500_000n, 1_700_000_000n);
      expect(feed.toXDR("base64")).toBe(readFixture("oracle-publish-feed.xdr.b64"));
      expect(value.toXDR("base64")).toBe(readFixture("oracle-publish-value.xdr.b64"));
      expect(ts.toXDR("base64")).toBe(readFixture("oracle-publish-timestamp.xdr.b64"));
      expect(feed.switch().name).toBe("scvSymbol");
      expect(value.switch().name).toBe("scvI128");
      expect(ts.switch().name).toBe("scvU64");
    });
  });

  it("documents that a wrong duration_days type would not match the fixture", () => {
    // Structural guard: if someone switched duration_days from u32 to u64,
    // the golden bytes would diverge.
    const correct = buildPolicyParamsScVal({
      coverageType: 0,
      coverageAmount: 10_000n * 10_000_000n,
      durationDays: 30,
      triggerThreshold: 500,
    });
    const wrongDuration = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("coverage_amount"),
        val: nativeToScVal(10_000n * 10_000_000n, { type: "i128" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("coverage_type"),
        val: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("StablecoinDepeg")]),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("duration_days"),
        val: nativeToScVal(30, { type: "u64" }), // wrong
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("trigger_threshold"),
        val: nativeToScVal(500n, { type: "i128" }),
      }),
    ]);
    expect(wrongDuration.toXDR("base64")).not.toBe(correct.toXDR("base64"));
  });
});
