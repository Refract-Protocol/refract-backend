import { AppConfig } from "./configuration";

/** Full stellar config defaults for unit tests — spreads cleanly under Partial overrides. */
export function testStellarConfig(
  overrides: Partial<AppConfig["stellar"]> = {}
): AppConfig["stellar"] {
  const {
    relayer: relayerOverrides,
    eventIndexer: eventIndexerOverrides,
    ...rest
  } = overrides;

  return {
    network: "testnet",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    poolContractId: "",
    policyContractId: "",
    oracleContractId: "",
    relayerSecret: "",
    validateOnChain: false,
    requireNetwork: false,
    validateTimeoutMs: 5_000,
    ...rest,
    relayer: {
      feeMultiplier: 1.2,
      feeCeiling: 1_000_000,
      idleResyncMs: 30_000,
      minBalance: 50_000_000,
      maxAttempts: 3,
      ...relayerOverrides,
    },
    eventIndexer: {
      enabled: false,
      pollIntervalMs: 5_000,
      lagAlertLedgers: 100,
      pageLimit: 100,
      ...eventIndexerOverrides,
    },
  };
}
