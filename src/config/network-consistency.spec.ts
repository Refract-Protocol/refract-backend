import {
  assertNetworkConsistency,
  classifyUrl,
  NetworkConsistencyError,
  STELLAR_NETWORKS,
  validateNetworkConsistency,
  verifyNetworkLive,
} from "./network-consistency";

const C = (fill: string) => `C${fill.repeat(55)}`;
const POOL = C("A");
const ORACLE = C("B");

const testnetEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  STELLAR_NETWORK: "testnet",
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
  STELLAR_NETWORK_PASSPHRASE: STELLAR_NETWORKS.testnet.passphrase,
  REFRACT_POOL_CONTRACT_ID_TESTNET: POOL,
  REFRACT_ORACLE_CONTRACT_ID_TESTNET: ORACLE,
  ORACLE_RELAYER_SECRET_ID: "refract/relayer",
  ...extra,
});

describe("validateNetworkConsistency", () => {
  it("accepts a consistent testnet configuration", () => {
    const report = validateNetworkConsistency(testnetEnv());
    expect(report).toMatchObject({ ok: true, errors: [], warnings: [] });
    expect(report.resolved).toMatchObject({
      network: "testnet",
      poolContractId: POOL,
      oracleContractId: ORACLE,
      rpcUrls: ["https://soroban-testnet.stellar.org"],
    });
  });

  it("defaults to testnet with a warning when nothing is configured", () => {
    const report = validateNetworkConsistency({});
    expect(report.ok).toBe(true);
    expect(report.warnings[0]).toMatch(/defaulting to testnet/);
  });

  it("warns, without failing, when payout configuration is incomplete", () => {
    const report = validateNetworkConsistency(
      testnetEnv({ REFRACT_ORACLE_CONTRACT_ID_TESTNET: "", ORACLE_RELAYER_SECRET_ID: "", ORACLE_RELAYER_SECRET: "" }),
    );
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual([
      expect.stringMatching(/missing oracle contract ID, relayer key .* can't pay out: StablecoinDepeg, MarketCrash/),
    ]);
  });

  it("never echoes the relayer secret", () => {
    const secret = "SBSECRETVALUESHOULDNOTAPPEAR";
    const report = validateNetworkConsistency(testnetEnv({ ORACLE_RELAYER_SECRET: secret, STELLAR_NETWORK_PASSPHRASE: "x" }));
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("treats public/pubnet as mainnet", () => {
    const report = validateNetworkConsistency({
      STELLAR_NETWORK: "public",
      STELLAR_HORIZON_URL: "https://horizon.stellar.org",
      REFRACT_POOL_CONTRACT_ID_PUBLIC: POOL,
      REFRACT_ORACLE_CONTRACT_ID_PUBLIC: ORACLE,
      ORACLE_RELAYER_SECRET_ID: "refract/relayer",
    });
    expect(report.ok).toBe(true);
    expect(report.resolved?.network).toBe("mainnet");
  });

  it("rejects an unknown network", () => {
    expect(validateNetworkConsistency({ STELLAR_NETWORK: "devnet" }).errors[0]).toMatch(/not a known network/);
  });

  it("requires STELLAR_NETWORK when network-suffixed values are present", () => {
    const report = validateNetworkConsistency({ REFRACT_POOL_CONTRACT_ID_MAINNET: POOL });
    expect(report.errors[0]).toMatch(/Set STELLAR_NETWORK explicitly/);
  });

  it("rejects values configured for another network", () => {
    const report = validateNetworkConsistency(testnetEnv({ REFRACT_ORACLE_CONTRACT_ID_MAINNET: C("D") }));
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([expect.stringMatching(/REFRACT_ORACLE_CONTRACT_ID_MAINNET is set for mainnet/)]);
  });

  it("rejects a passphrase from another network", () => {
    const report = validateNetworkConsistency(
      testnetEnv({ STELLAR_NETWORK_PASSPHRASE: STELLAR_NETWORKS.mainnet.passphrase }),
    );
    expect(report.errors).toEqual([expect.stringMatching(/the mainnet passphrase but STELLAR_NETWORK=testnet/)]);
  });

  it("rejects RPC and Horizon URLs that point at another network", () => {
    const report = validateNetworkConsistency(
      testnetEnv({
        SOROBAN_RPC_URL: "https://rpc-futurenet.stellar.org",
        STELLAR_HORIZON_URL: "https://horizon.stellar.org",
        SOROBAN_RPC_URLS: "https://rpc.example.com/stellar-mainnet",
      }),
    );
    expect(report.errors).toHaveLength(3);
    expect(report.errors.join("\n")).toMatch(/SOROBAN_RPC_URL .* points to futurenet/);
    expect(report.errors.join("\n")).toMatch(/STELLAR_HORIZON_URL .* points to mainnet/);
    expect(report.errors.join("\n")).toMatch(/SOROBAN_RPC_URLS entry .* points to mainnet/);
  });

  it("warns, but does not fail, on hosts it can't classify", () => {
    const report = validateNetworkConsistency(testnetEnv({ SOROBAN_RPC_URL: "https://rpc.internal.example" }));
    expect(report.ok).toBe(true);
    expect(report.warnings[0]).toMatch(/STELLAR_VALIDATE_ONCHAIN/);
  });

  it("rejects conflicting suffixed and unsuffixed values", () => {
    const report = validateNetworkConsistency(testnetEnv({ REFRACT_POOL_CONTRACT_ID: C("E") }));
    expect(report.errors[0]).toMatch(/Conflicting values for the testnet poolContractId/);
    // Identical values are fine.
    expect(validateNetworkConsistency(testnetEnv({ POOL_CONTRACT_ID: POOL })).ok).toBe(true);
  });

  it("rejects malformed and duplicated contract IDs", () => {
    expect(validateNetworkConsistency(testnetEnv({ REFRACT_ORACLE_CONTRACT_ID_TESTNET: "Cabc" })).errors[0]).toMatch(
      /oracleContractId is not a valid/,
    );
    expect(validateNetworkConsistency(testnetEnv({ REFRACT_ORACLE_CONTRACT_ID_TESTNET: POOL })).errors[0]).toMatch(
      /same contract ID/,
    );
  });

  it("requires https on mainnet", () => {
    const report = validateNetworkConsistency({
      STELLAR_NETWORK: "mainnet",
      SOROBAN_RPC_URL: "http://mainnet-rpc.example",
    });
    expect(report.errors[0]).toMatch(/must use https on mainnet/);
  });

  it("assertNetworkConsistency lists every problem at once", () => {
    try {
      assertNetworkConsistency(
        testnetEnv({
          STELLAR_NETWORK_PASSPHRASE: STELLAR_NETWORKS.futurenet.passphrase,
          REFRACT_POOL_CONTRACT_ID_FUTURENET: C("F"),
        }),
      );
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkConsistencyError);
      expect((err as NetworkConsistencyError).errors).toHaveLength(2);
    }
  });
});

describe("classifyUrl", () => {
  it("knows SDF hosts and recognises network words in custom hosts", () => {
    expect(classifyUrl("https://horizon-testnet.stellar.org")).toEqual({ network: "testnet", known: true });
    expect(classifyUrl("https://soroban.futurenet.example")).toEqual({ network: "futurenet", known: false });
    expect(classifyUrl("https://rpc.example")).toEqual({ known: false });
  });
});

describe("verifyNetworkLive", () => {
  const respond = (body: unknown, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 503, json: async () => body });

  it("flags endpoints that serve another network's passphrase", async () => {
    const fetch = jest.fn((url: string, _init?: { body?: string }) =>
      url.includes("horizon")
        ? respond({ network_passphrase: STELLAR_NETWORKS.mainnet.passphrase })
        : respond({ result: { passphrase: STELLAR_NETWORKS.testnet.passphrase } }),
    );
    const result = await verifyNetworkLive(
      { network: "testnet", rpcUrls: ["https://rpc.example"], horizonUrl: "https://horizon.example" },
      { fetch },
    );
    expect(result.mismatches).toEqual([expect.stringMatching(/Horizon \(horizon.example\) serves "Public Global/)]);
    expect(result.unreachable).toEqual([]);
    expect(JSON.parse(fetch.mock.calls[0][1]!.body!)).toMatchObject({ method: "getNetwork" });
  });

  it("reports unreachable endpoints separately", async () => {
    const result = await verifyNetworkLive(
      { network: "testnet", rpcUrls: ["https://rpc.example"] },
      { fetch: () => respond({}, false) },
    );
    expect(result.mismatches).toEqual([]);
    expect(result.unreachable[0]).toMatch(/not reachable.*HTTP 503/);
  });
});
