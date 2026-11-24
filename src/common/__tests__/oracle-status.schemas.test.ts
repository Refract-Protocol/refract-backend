import {
  severitySchema,
  decisionSchema,
  freshnessStateSchema,
  trustModeSchema,
  sourceHealthSchema,
} from "../oracle-status.schemas";

describe("severitySchema", () => {
  it("accepts known severity values", () => {
    for (const value of ["low", "medium", "high", "triggered"] as const) {
      expect(severitySchema.safeParse(value).success).toBe(true);
    }
  });

  it("rejects an unknown severity string", () => {
    const result = severitySchema.safeParse("critical");
    expect(result.success).toBe(false);
  });

  it("rejects an empty string", () => {
    const result = severitySchema.safeParse("");
    expect(result.success).toBe(false);
  });

  it("rejects a non-string value", () => {
    expect(severitySchema.safeParse(1).success).toBe(false);
    expect(severitySchema.safeParse(null).success).toBe(false);
  });
});

describe("decisionSchema", () => {
  const validDecision = {
    evidenceRef: "abc123",
    value: 0.9998,
    severity: "low",
    method: "single_source",
    quorum: { required: 1, achieved: 1, met: true, windowSeconds: 120 },
    divergenceBps: 0,
    decidedAt: "2024-06-01T12:00:00.000Z",
  };

  it("accepts a valid decision with a known severity", () => {
    expect(decisionSchema.safeParse(validDecision).success).toBe(true);
  });

  it("rejects a decision with an unknown severity string", () => {
    const result = decisionSchema.safeParse({ ...validDecision, severity: "catastrophic" });
    expect(result.success).toBe(false);
  });

  it("rejects a decision with a missing severity", () => {
    const { severity: _, ...withoutSeverity } = validDecision;
    const result = decisionSchema.safeParse(withoutSeverity);
    expect(result.success).toBe(false);
  });
});

describe("freshnessStateSchema", () => {
  it("accepts known states", () => {
    for (const v of ["live", "degraded", "paused", "unknown"] as const) {
      expect(freshnessStateSchema.safeParse(v).success).toBe(true);
    }
  });

  it("rejects an unknown state", () => {
    expect(freshnessStateSchema.safeParse("active").success).toBe(false);
  });
});

describe("trustModeSchema", () => {
  it("accepts known modes", () => {
    for (const v of ["multi_source", "single_source", "none"] as const) {
      expect(trustModeSchema.safeParse(v).success).toBe(true);
    }
  });

  it("rejects an unknown mode", () => {
    expect(trustModeSchema.safeParse("decentralized").success).toBe(false);
  });
});

describe("sourceHealthSchema", () => {
  it("accepts known health values", () => {
    for (const v of ["healthy", "stale", "down"] as const) {
      expect(sourceHealthSchema.safeParse(v).success).toBe(true);
    }
  });

  it("rejects an unknown health value", () => {
    expect(sourceHealthSchema.safeParse("degraded").success).toBe(false);
  });
});
