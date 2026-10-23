import { Keypair } from "@stellar/stellar-sdk";
import { OracleSandboxService, registrationMessage } from "./oracle-sandbox.service";
import { assertOracleSandboxSafety, loadOracleSandboxConfig } from "./oracle-sandbox.config";
import { signReading, verifyReadingSignature } from "./provider-submission";

const NOW = Date.parse("2026-10-01T12:00:00Z");

function setup(env: NodeJS.ProcessEnv = {}) {
  let now = NOW;
  const service = new OracleSandboxService(
    loadOracleSandboxConfig({ ORACLE_SANDBOX_MODE: "true", ...env }),
    () => now,
  );
  const register = (name: string) => {
    const kp = Keypair.random();
    const signature = kp.sign(Buffer.from(registrationMessage(kp.publicKey(), name))).toString("base64");
    service.registerProvider({ providerId: kp.publicKey(), name, signature });
    return kp;
  };
  let n = 0;
  const reading = (kp: Keypair, value: string, overrides: Partial<{ feed: string; observedAt: string; nonce: string }> = {}) =>
    signReading("sandbox", kp.secret(), {
      feed: "StablecoinDepeg",
      value,
      observedAt: new Date(now).toISOString(),
      nonce: `nonce-${++n}-abcdefgh`,
      ...overrides,
    });
  return { service, register, reading, advance: (ms: number) => (now += ms) };
}

describe("provider submission signatures", () => {
  it("are bound to the deployment domain", () => {
    const kp = Keypair.random();
    const sub = signReading("sandbox", kp.secret(), {
      feed: "MarketCrash",
      value: "-30.12",
      observedAt: new Date(NOW).toISOString(),
      nonce: "abcdefgh1",
    });
    expect(verifyReadingSignature("sandbox", sub)).toBe(true);
    expect(verifyReadingSignature("production", sub)).toBe(false);
    expect(verifyReadingSignature("sandbox", { ...sub, value: "-30.13" })).toBe(false);
  });
});

describe("OracleSandboxService", () => {
  it("refuses registration without proof of key ownership", () => {
    const { service } = setup();
    const kp = Keypair.random();
    const other = Keypair.random();
    const signature = other.sign(Buffer.from(registrationMessage(kp.publicKey(), "x"))).toString("base64");
    expect(() => service.registerProvider({ providerId: kp.publicKey(), name: "x", signature })).toThrow(/signature/);
  });

  it("walks readings through corroboration to an accepted decision", () => {
    const { service, register, reading } = setup();
    const [a, b, c] = ["alpha", "beta", "gamma"].map(register);

    expect(service.submit(reading(a, "0.9998")).status).toBe("awaiting_corroboration");
    const second = service.submit(reading(b, "0.9999"));
    expect(second.corroboration).toEqual({ providers: 2, required: 3 });

    const third = service.submit(reading(c, "1.0001"));
    expect(third.status).toBe("decided");
    expect(third.decision).toMatchObject({ status: "accepted", value: 0.9999, published: false });
    expect(service.listDecisions("StablecoinDepeg")).toHaveLength(1);
  });

  it("records an outlier rejection that links to the decision", () => {
    const { service, register, reading } = setup();
    const [a, b, c, d] = ["a", "b", "c", "d"].map(register);
    service.submit(reading(a, "1.0000"));
    service.submit(reading(b, "1.0000"));
    service.submit(reading(c, "1.0000"));
    const trace = service.submit(reading(d, "0.9000"));

    expect(trace.decision?.status).toBe("accepted");
    expect(trace.decision?.outlierProviders).toEqual([d.publicKey()]);
    expect(trace.rejection).toMatchObject({ reason: "outlier", decisionId: trace.decision?.id });
    expect(service.listRejections({ providerId: d.publicKey() })[0].reason).toBe("outlier");
  });

  it("rejects bad input with a specific reason", () => {
    const { service, register, reading, advance } = setup();
    const kp = register("p");
    const stranger = Keypair.random();

    expect(service.submit({ feed: 1 }).rejection?.reason).toBe("invalid_shape");
    expect(service.submit(reading(kp, "1", { feed: "Weather" })).rejection?.reason).toBe("unknown_feed");
    expect(service.submit(reading(stranger, "1")).rejection?.reason).toBe("unregistered_provider");
    expect(service.submit({ ...reading(kp, "1"), value: "2" }).rejection?.reason).toBe("bad_signature");
    expect(
      service.submit(reading(kp, "1", { observedAt: new Date(NOW + 120_000).toISOString() })).rejection?.reason,
    ).toBe("from_future");

    const replay = reading(kp, "1");
    expect(service.submit(replay).status).toBe("awaiting_corroboration");
    expect(service.submit(replay).rejection?.reason).toBe("replayed_nonce");

    const old = reading(kp, "1");
    advance(10 * 60_000);
    expect(service.submit(old).rejection?.reason).toBe("stale");
  });

  it("does not burn a nonce on a forged submission", () => {
    const { service, register, reading } = setup();
    const kp = register("p");
    const genuine = reading(kp, "1");
    expect(service.submit({ ...genuine, signature: Buffer.alloc(64).toString("base64") }).rejection?.reason).toBe(
      "bad_signature",
    );
    expect(service.submit(genuine).status).toBe("awaiting_corroboration");
  });

  it("rate-limits each provider", () => {
    const { service, register, reading, advance } = setup({ ORACLE_SANDBOX_MAX_SUBMISSIONS_PER_MINUTE: "2" });
    const kp = register("p");
    expect(service.submit(reading(kp, "1")).status).not.toBe("rejected");
    expect(service.submit(reading(kp, "1")).status).not.toBe("rejected");
    expect(service.submit(reading(kp, "1")).rejection?.reason).toBe("rate_limited");
    advance(60_001);
    expect(service.submit(reading(kp, "1")).status).not.toBe("rejected");
  });

  it("purges decisions and rejections past the retention period", () => {
    const { service, register, reading, advance } = setup({ ORACLE_SANDBOX_RETENTION_MS: "3600000" });
    const kp = register("p");
    service.submit({ ...reading(kp, "1"), value: "x" });
    expect(service.listRejections()).toHaveLength(1);
    advance(3_600_001);
    expect(service.listRejections()).toHaveLength(0);
  });

  it("bounds the number of providers", () => {
    const { service, register } = setup({ ORACLE_SANDBOX_MAX_PROVIDERS: "1" });
    register("one");
    expect(() => register("two")).toThrow(/limit/);
    expect(service.listProviders()).toHaveLength(1);
  });
});

describe("assertOracleSandboxSafety", () => {
  it("is a no-op when the sandbox is off", () => {
    expect(() => assertOracleSandboxSafety({ ORACLE_RELAYER_SECRET: "S..." })).not.toThrow();
  });

  it("refuses a relayer key or mainnet in sandbox mode", () => {
    expect(() => assertOracleSandboxSafety({ ORACLE_SANDBOX_MODE: "true", ORACLE_RELAYER_SECRET: "S..." })).toThrow(
      /relayer signing key/,
    );
    expect(() => assertOracleSandboxSafety({ ORACLE_SANDBOX_MODE: "true", STELLAR_NETWORK: "public" })).toThrow(
      /test networks/,
    );
    expect(() => assertOracleSandboxSafety({ ORACLE_SANDBOX_MODE: "true", STELLAR_NETWORK: "testnet" })).not.toThrow();
  });
});
