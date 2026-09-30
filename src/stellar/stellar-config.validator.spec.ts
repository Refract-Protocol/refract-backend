import { ConfigService } from "@nestjs/config";
import { Keypair, StrKey, rpc } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { testStellarConfig } from "../config/test-stellar";
import { NETWORK_PASSPHRASES, StellarConfigValidator } from "./stellar-config.validator";

function buildConfig(overrides: Partial<AppConfig["stellar"]> = {}): ConfigService<AppConfig, true> {
  const stellar = testStellarConfig(overrides);
  return {
    get: jest.fn((key: string) => {
      if (key === "stellar") return stellar;
      return undefined;
    }),
  } as unknown as ConfigService<AppConfig, true>;
}

describe("StellarConfigValidator", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("passes validation for a well-formed testnet config", async () => {
    const secret = Keypair.random().secret();
    const pool = StrKey.encodeContract(Buffer.alloc(32, 1));
    const validator = new StellarConfigValidator(
      buildConfig({
        poolContractId: pool,
        relayerSecret: secret,
        validateOnChain: false,
        network: "testnet",
        networkPassphrase: NETWORK_PASSPHRASES.testnet,
      })
    );

    const health = await validator.validate();
    expect(health.fullyConfigured).toBe(true);
    expect(health.relayerPublicKey).toBe(Keypair.fromSecret(secret).publicKey());
    expect(health.contracts.pool.valid).toBe(true);
    expect(validator.isNetworkFullyConfigured()).toBe(true);
  });

  it("rejects a malformed contract ID", async () => {
    const validator = new StellarConfigValidator(
      buildConfig({
        poolContractId: "not-a-contract",
        relayerSecret: Keypair.random().secret(),
        validateOnChain: false,
        requireNetwork: false,
      })
    );

    await expect(validator.validate()).rejects.toThrow(/Invalid pool contract ID/);
  });

  it("rejects a mismatched network passphrase", async () => {
    const validator = new StellarConfigValidator(
      buildConfig({
        poolContractId: StrKey.encodeContract(Buffer.alloc(32, 2)),
        relayerSecret: Keypair.random().secret(),
        validateOnChain: false,
        network: "testnet",
        networkPassphrase: NETWORK_PASSPHRASES.public,
      })
    );

    await expect(validator.validate()).rejects.toThrow(/STELLAR_NETWORK_PASSPHRASE does not match/);
  });

  it("rejects an invalid relayer seed without leaking the value", async () => {
    const badSecret = "SSECRET_LEAK_CANDIDATE_XXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    const validator = new StellarConfigValidator(
      buildConfig({
        poolContractId: StrKey.encodeContract(Buffer.alloc(32, 3)),
        relayerSecret: badSecret,
        validateOnChain: false,
      })
    );

    await expect(validator.validate()).rejects.toThrow(/Invalid ORACLE_RELAYER_SECRET/);
    try {
      await validator.validate();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(badSecret);
    }
  });

  it("treats empty config as degraded but startable when requireNetwork is false", async () => {
    const validator = new StellarConfigValidator(
      buildConfig({
        poolContractId: "",
        relayerSecret: "",
        validateOnChain: false,
        requireNetwork: false,
      })
    );

    const health = await validator.validate();
    expect(health.fullyConfigured).toBe(false);
    expect(validator.isNetworkFullyConfigured()).toBe(false);
  });

  it("does not hang when an on-chain liveness probe times out", async () => {
    jest.useFakeTimers();
    const pool = StrKey.encodeContract(Buffer.alloc(32, 4));
    const validator = new StellarConfigValidator(
      buildConfig({
        poolContractId: pool,
        relayerSecret: Keypair.random().secret(),
        validateOnChain: true,
        validateTimeoutMs: 50,
        requireNetwork: false,
      })
    );

    jest.spyOn(rpc.Server.prototype, "getLedgerEntries").mockImplementation(
      () => new Promise(() => undefined) as never
    );

    const validatePromise = validator.validate();
    await jest.advanceTimersByTimeAsync(100);
    const health = await validatePromise;

    expect(health.contracts.pool.reachable).toBe(false);
    expect(health.errors.some((e) => e.includes("not reachable"))).toBe(true);
    jest.useRealTimers();
  });
});
