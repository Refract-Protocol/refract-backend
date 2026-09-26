/**
 * Typed application configuration, loaded once by Nest's ConfigModule.
 *
 * Kept as a single factory function (rather than scattered `process.env`
 * reads) so every consumer gets the same parsed/defaulted values and the
 * shape is documented in one place. See `.env.example` for the full list
 * of variables this reads.
 *
 * `AppConfig` is inferred from the Zod schema in `./env.schema` so the
 * TypeScript type and the runtime validation cannot drift.
 */
import { z } from "zod";
import { validateEnv } from "./env.schema";

const appConfigSchema = z.object({
  port: z.number().int().min(1).max(65535),
  frontendUrl: z.string().url(),
  database: z.object({ url: z.string().url() }),
  redis: z.object({ url: z.string().url() }),
  stellar: z.object({
    network: z.string(),
    sorobanRpcUrl: z.string().url(),
    networkPassphrase: z.string(),
    poolContractId: z.string(),
    policyContractId: z.string(),
    oracleContractId: z.string(),
    relayerSecret: z.string(),
  }),
  oracles: z.object({
    coingeckoBaseUrl: z.string().url(),
    horizonUrl: z.string().url(),
    defiLlamaBaseUrl: z.string().url(),
    defiLlamaProtocolSlug: z.string(),
    httpTimeoutMs: z.number().int().min(100).max(120_000),
  }),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export default (): AppConfig => {
  const env = validateEnv(process.env);

  const requireChainConfig = env.REQUIRE_CHAIN_CONFIG === true;
  const chainKeys = [
    "REFRACT_POOL_CONTRACT_ID",
    "REFRACT_POLICY_CONTRACT_ID",
    "REFRACT_ORACLE_CONTRACT_ID",
    "ORACLE_RELAYER_SECRET",
  ] as const;

  if (requireChainConfig) {
    const missing = chainKeys.filter((key) => !env[key]);
    if (missing.length > 0) {
      throw new Error(
        `Invalid environment configuration:\n${missing
          .map((key) => `  - ${key}: required when REQUIRE_CHAIN_CONFIG is set`)
          .join("\n")}`,
      );
    }
  }

  return {
    port: env.PORT ?? 4001,
    frontendUrl: env.FRONTEND_URL ?? "http://localhost:3000",
    database: {
      url:
        env.DATABASE_URL ??
        "postgres://refract:refract@localhost:5432/refract",
    },
    redis: {
      url: env.REDIS_URL ?? "redis://localhost:6379",
    },
    stellar: {
      network: env.STELLAR_NETWORK ?? "testnet",
      sorobanRpcUrl:
        env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org",
      networkPassphrase:
        env.STELLAR_NETWORK_PASSPHRASE ??
        "Test SDF Network ; September 2015",
      poolContractId: env.REFRACT_POOL_CONTRACT_ID ?? "",
      policyContractId: env.REFRACT_POLICY_CONTRACT_ID ?? "",
      oracleContractId: env.REFRACT_ORACLE_CONTRACT_ID ?? "",
      relayerSecret: env.ORACLE_RELAYER_SECRET ?? "",
    },
    oracles: {
      coingeckoBaseUrl:
        env.COINGECKO_BASE_URL ?? "https://api.coingecko.com/api/v3",
      horizonUrl:
        env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org",
      defiLlamaBaseUrl: env.DEFILLAMA_BASE_URL ?? "https://api.llama.fi",
      // Placeholder "covered protocol" for the SmartContractRisk TVL-drop
      // check until Refract defines a real list of covered Soroban
      // protocols. Defaults to a large, consistently-tracked protocol so
      // the drop-detection logic has real data to run against.
      defiLlamaProtocolSlug: env.DEFILLAMA_PROTOCOL_SLUG ?? "aave",
      httpTimeoutMs: env.ORACLE_HTTP_TIMEOUT_MS ?? 5000,
    },
  };
};
