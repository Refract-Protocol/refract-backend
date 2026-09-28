/**
 * Typed application configuration, loaded once by Nest's ConfigModule.
 *
 * Kept as a single factory function (rather than scattered `process.env`
 * reads) so every consumer gets the same parsed/defaulted values and the
 * shape is documented in one place. See `.env.example` for the full list
 * of variables this reads.
 */
export interface AppConfig {
  port: number;
  frontendUrl: string;
  database: {
    url: string;
  };
  redis: {
    url: string;
  };
  stellar: {
    network: "testnet" | "futurenet" | "mainnet";
    sorobanRpcUrl: string;
    horizonUrl: string;
    networkPassphrase: string;
    poolContractId: string;
    policyContractId: string;
    oracleContractId: string;
    relayerSecret: string;
  };
  oracles: {
    coingeckoBaseUrl: string;
    horizonUrl: string;
    defiLlamaBaseUrl: string;
    defiLlamaProtocolSlug: string;
    httpTimeoutMs: number;
  };
}

const NETWORKS = {
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

type StellarNetwork = keyof typeof NETWORKS;

function selectedNetwork(): StellarNetwork {
  const network = process.env.STELLAR_NETWORK || "testnet";
  if (Object.prototype.hasOwnProperty.call(NETWORKS, network)) return network as StellarNetwork;
  throw new Error(`Invalid STELLAR_NETWORK "${network}"; expected testnet, futurenet, or mainnet`);
}

function networkContractId(name: "POOL" | "POLICY" | "ORACLE", network: StellarNetwork): string {
  return process.env[`REFRACT_${name}_CONTRACT_ID_${network.toUpperCase()}`] || "";
}

export default (): AppConfig => {
  const network = selectedNetwork();
  const networkConfig = NETWORKS[network];
  return {
    port: parseInt(process.env.PORT || "4001", 10),
    frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",
    database: {
    url: process.env.DATABASE_URL || "postgres://refract:refract@localhost:5432/refract",
    },
    redis: {
      url: process.env.REDIS_URL || "redis://localhost:6379",
    },
    stellar: {
      network,
      ...networkConfig,
      poolContractId: networkContractId("POOL", network),
      policyContractId: networkContractId("POLICY", network),
      oracleContractId: networkContractId("ORACLE", network),
      relayerSecret: process.env.ORACLE_RELAYER_SECRET || "",
    },
    oracles: {
      coingeckoBaseUrl: process.env.COINGECKO_BASE_URL || "https://api.coingecko.com/api/v3",
      horizonUrl: networkConfig.horizonUrl,
      defiLlamaBaseUrl: process.env.DEFILLAMA_BASE_URL || "https://api.llama.fi",
      // Placeholder "covered protocol" for the SmartContractRisk TVL-drop
      // check until Refract defines a real list of covered Soroban
      // protocols. Defaults to a large, consistently-tracked protocol so
      // the drop-detection logic has real data to run against.
      defiLlamaProtocolSlug: process.env.DEFILLAMA_PROTOCOL_SLUG || "aave",
      httpTimeoutMs: parseInt(process.env.ORACLE_HTTP_TIMEOUT_MS || "5000", 10),
    },
  };
};
