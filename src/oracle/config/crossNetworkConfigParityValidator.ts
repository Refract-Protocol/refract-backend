export type SupportedStellarNetwork =
  | "testnet"
  | "mainnet"
  | "futurenet"
  | "standalone";

export const CANONICAL_PASSPHRASES: Record<SupportedStellarNetwork, string> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
  standalone: "Standalone Network ; February 2017",
};

export interface CrossNetworkParityResult {
  valid: boolean;
  selectedNetwork: SupportedStellarNetwork | null;
  offendingMixedKeys: string[];
  errors: string[];
  warnings: string[];
  unavailableCoverages: string[];
}

const NETWORK_SUFFIXES: Record<SupportedStellarNetwork, string> = {
  testnet: "_TESTNET",
  mainnet: "_MAINNET",
  futurenet: "_FUTURENET",
  standalone: "_STANDALONE",
};

export function validateCrossNetworkConfigParity(params: {
  env: Record<string, string | undefined>;
  rpcReportedPassphrase?: string;
  liveCoverageTypes?: string[];
}): CrossNetworkParityResult {
  const rawNet = (params.env.STELLAR_NETWORK ?? "").trim().toLowerCase();
  const errors: string[] = [];
  const warnings: string[] = [];
  const offendingMixedKeys: string[] = [];
  const liveCoverages = params.liveCoverageTypes ?? [
    "USDC-DEPEG",
    "PROTOCOL-TVL-DROP",
    "VALIDATOR-SLASHER",
  ];

  if (
    rawNet !== "testnet" &&
    rawNet !== "mainnet" &&
    rawNet !== "futurenet" &&
    rawNet !== "standalone"
  ) {
    return {
      valid: false,
      selectedNetwork: null,
      offendingMixedKeys: [],
      errors: [
        `UNSUPPORTED_STELLAR_NETWORK: STELLAR_NETWORK must be one of testnet, mainnet, futurenet, standalone`,
      ],
      warnings: [],
      unavailableCoverages: liveCoverages,
    };
  }

  const selectedNetwork: SupportedStellarNetwork = rawNet;
  const expectedSuffix = NETWORK_SUFFIXES[selectedNetwork];

  // 1. Detect mixed-network suffixed environment keys (never echoing secret values)
  for (const [key, val] of Object.entries(params.env)) {
    if (!val || val.trim() === "") continue;
    for (const [net, suffix] of Object.entries(NETWORK_SUFFIXES)) {
      if (net !== selectedNetwork && key.endsWith(suffix)) {
        offendingMixedKeys.push(key);
      }
    }
  }

  if (offendingMixedKeys.length > 0) {
    errors.push(
      `MIXED_NETWORK_ENV_KEYS: Selected network '${selectedNetwork}' cannot be combined with non-selected keys: ${offendingMixedKeys.join(", ")}`
    );
  }

  // 2. Validate network passphrase parity against canonical and RPC-reported passphrase
  const configuredPassphrase =
    params.env[`STELLAR_NETWORK_PASSPHRASE${expectedSuffix}`] ??
    params.env.STELLAR_NETWORK_PASSPHRASE;
  const canonicalPassphrase = CANONICAL_PASSPHRASES[selectedNetwork];

  if (
    configuredPassphrase &&
    configuredPassphrase !== canonicalPassphrase
  ) {
    errors.push(
      `PASSPHRASE_MISMATCH: Configured passphrase does not match canonical '${selectedNetwork}' passphrase`
    );
  }

  if (
    params.rpcReportedPassphrase &&
    params.rpcReportedPassphrase !== canonicalPassphrase
  ) {
    errors.push(
      `RPC_PASSPHRASE_MISMATCH: RPC endpoint reported passphrase '${params.rpcReportedPassphrase}' which does not match '${selectedNetwork}'`
    );
  }

  // 3. Warn when payout-triggering configuration is incomplete for selected network
  const oracleContractId =
    params.env[`REFRACT_ORACLE_CONTRACT_ID${expectedSuffix}`];
  const relayerKey = params.env[`RELAYER_SECRET_KEY${expectedSuffix}`];
  const unavailableCoverages: string[] = [];

  if (!oracleContractId || !relayerKey) {
    const missingNames: string[] = [];
    if (!oracleContractId) {
      missingNames.push(`REFRACT_ORACLE_CONTRACT_ID${expectedSuffix}`);
    }
    if (!relayerKey) {
      missingNames.push(`RELAYER_SECRET_KEY${expectedSuffix}`);
    }
    warnings.push(
      `INCOMPLETE_PAYOUT_CONFIG: Missing ${missingNames.join(", ")}; live payout coverages (${liveCoverages.join(", ")}) are unavailable`
    );
    unavailableCoverages.push(...liveCoverages);
  }

  return {
    valid: errors.length === 0,
    selectedNetwork,
    offendingMixedKeys,
    errors,
    warnings,
    unavailableCoverages,
  };
}
