import { corroborate, CorroborationInput, median } from "./corroboration";

const policy = { minProviders: 3, maxDeviationRatio: 0.01, absoluteTolerance: 0, windowMs: 60_000 };
const NOW = 1_000_000;
const r = (providerId: string, value: number, ageMs = 0, id = `${providerId}-${value}`): CorroborationInput => ({
  submissionId: id,
  providerId,
  value,
  observedAtMs: NOW - ageMs,
});

describe("corroborate", () => {
  it("computes the median for odd and even sets", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it("stays pending until enough distinct providers report", () => {
    const out = corroborate("F", [r("a", 1), r("a", 1.001, 10, "dup"), r("b", 1)], policy, NOW);
    expect(out).toEqual({ status: "pending", feed: "F", providers: 2, required: 3 });
  });

  it("ignores readings outside the window", () => {
    const out = corroborate("F", [r("a", 1), r("b", 1), r("c", 1, 61_000)], policy, NOW);
    expect(out.status).toBe("pending");
  });

  it("uses only each provider's latest reading", () => {
    const out = corroborate("F", [r("a", 5, 30_000, "old"), r("a", 1, 0, "new"), r("b", 1), r("c", 1)], policy, NOW);
    expect(out.status).toBe("accepted");
    if (out.status === "accepted") {
      expect(out.agreeing.map((x) => x.submissionId)).toContain("new");
      expect(out.agreeing.map((x) => x.submissionId)).not.toContain("old");
    }
  });

  it("accepts when agreeing providers meet the quorum and reports outliers", () => {
    const out = corroborate("F", [r("a", 1), r("b", 1.002), r("c", 0.998), r("d", 1.5)], policy, NOW);
    expect(out.status).toBe("accepted");
    if (out.status !== "pending") {
      expect(out.value).toBe(1);
      expect(out.outliers.map((x) => x.providerId)).toEqual(["d"]);
    }
  });

  it("rejects when outliers break the quorum", () => {
    const out = corroborate("F", [r("a", 1), r("b", 1.2), r("c", 0.8)], policy, NOW);
    expect(out.status).toBe("rejected");
    if (out.status !== "pending") {
      expect(out.reason).toBe("insufficient_agreement");
      expect(out.value).toBeNull();
    }
  });

  it("applies the absolute tolerance for feeds near zero", () => {
    const readings = [r("a", 0.1), r("b", -0.1), r("c", 0)];
    expect(corroborate("F", readings, policy, NOW).status).toBe("rejected");
    expect(corroborate("F", readings, { ...policy, absoluteTolerance: 0.5 }, NOW).status).toBe("accepted");
  });
});
