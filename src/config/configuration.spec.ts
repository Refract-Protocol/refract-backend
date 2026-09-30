import configuration from "./configuration";

const NETWORK_CONFIG = {
  testnet: {
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  },
  futurenet: {
    sorobanRpcUrl: "https://soroban-futurenet.stellar.org",
    horizonUrl: "https://horizon-futurenet.stellar.org",
    networkPassphrase: "Test SDF Future Network ; October 2022",
  },
  mainnet: {
    sorobanRpcUrl: "https://soroban-rpc.mainnet.stellar.org",
    horizonUrl: "https://horizon.stellar.org",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
  },
} as const;

describe("Stellar network configuration", () => {
  const originalEnv = new Map<string, string | undefined>();

  function setEnv(name: string, value: string | undefined): void {
    if (!originalEnv.has(name)) originalEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  afterEach(() => {
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    originalEnv.clear();
  });

  it.each(Object.entries(NETWORK_CONFIG))("selects all Stellar endpoints and IDs together for %s", (network, expected) => {
    const suffix = network.toUpperCase();
    setEnv("STELLAR_NETWORK", network);
    setEnv(`REFRACT_POOL_CONTRACT_ID_${suffix}`, `${suffix}-pool`);
    setEnv(`REFRACT_POLICY_CONTRACT_ID_${suffix}`, `${suffix}-policy`);
    setEnv(`REFRACT_ORACLE_CONTRACT_ID_${suffix}`, `${suffix}-oracle`);
    setEnv("SOROBAN_RPC_URL", "https://wrong-network.invalid");
    setEnv("STELLAR_NETWORK_PASSPHRASE", "wrong passphrase");

    const config = configuration();

    expect(config.stellar).toMatchObject({
      network,
      ...expected,
      poolContractId: `${suffix}-pool`,
      policyContractId: `${suffix}-policy`,
      oracleContractId: `${suffix}-oracle`,
    });
    expect(config.oracles.horizonUrl).toBe(expected.horizonUrl);
  });

  it("rejects unsupported network selectors", () => {
    setEnv("STELLAR_NETWORK", "local");

    expect(configuration).toThrow("expected testnet, futurenet, or mainnet");
  });
});
