import { z } from "zod";

export const ORACLE_RESPONSE_SCHEMA_VERSION = 1;
export const MAX_ORACLE_RESPONSE_BYTES = 64 * 1024;
export const MAX_TVL_POINTS = 1_000;

const finiteNumber = z.number().finite();

export const CoinGeckoStablecoinV1 = z
  .object({
    "usd-coin": z.object({ usd: finiteNumber.positive() }).strict(),
  })
  .strict();

export const CoinGeckoMarketV1 = z
  .object({
    stellar: z
      .object({
        usd: finiteNumber.positive(),
        usd_24h_change: finiteNumber,
      })
      .strict(),
  })
  .strict();

export const HorizonLedgerV1 = z
  .object({
    _embedded: z
      .object({
        records: z
          .array(
            z
              .object({
                sequence: z.number().int().positive().safe(),
                closed_at: z.string().datetime({ offset: true }),
              })
              .passthrough(),
          )
          .length(1),
      })
      .passthrough(),
  })
  .passthrough();

export const DefiLlamaProtocolV1 = z
  .object({
    name: z.string().min(1).max(100).optional(),
    tvl: z
      .array(
        z
          .object({
            date: z.number().int().positive().safe(),
            totalLiquidityUSD: finiteNumber.nonnegative(),
          })
          .passthrough(),
      )
      .min(2)
      .max(MAX_TVL_POINTS),
  })
  .passthrough();

type VersionedSchema<T extends z.ZodType> = {
  readonly version: typeof ORACLE_RESPONSE_SCHEMA_VERSION;
  readonly schema: T;
};

export const oracleProviderSchemas = {
  coingeckoStablecoin: {
    version: ORACLE_RESPONSE_SCHEMA_VERSION,
    schema: CoinGeckoStablecoinV1,
  },
  coingeckoMarket: {
    version: ORACLE_RESPONSE_SCHEMA_VERSION,
    schema: CoinGeckoMarketV1,
  },
  horizonLedger: {
    version: ORACLE_RESPONSE_SCHEMA_VERSION,
    schema: HorizonLedgerV1,
  },
  defiLlamaProtocol: {
    version: ORACLE_RESPONSE_SCHEMA_VERSION,
    schema: DefiLlamaProtocolV1,
  },
} satisfies Record<string, VersionedSchema<z.ZodType>>;

export type CoinGeckoStablecoinResponse = z.infer<typeof CoinGeckoStablecoinV1>;
export type CoinGeckoMarketResponse = z.infer<typeof CoinGeckoMarketV1>;
export type HorizonLedgerResponse = z.infer<typeof HorizonLedgerV1>;
export type DefiLlamaProtocolResponse = z.infer<typeof DefiLlamaProtocolV1>;

export function parseProviderResponse<T extends z.ZodType>(
  provider: string,
  body: string | Buffer,
  schema: T,
): z.infer<T> {
  const byteLength = Buffer.byteLength(body);
  if (byteLength > MAX_ORACLE_RESPONSE_BYTES) {
    throw new Error(`${provider} response exceeds ${MAX_ORACLE_RESPONSE_BYTES} bytes`);
  }

  let value: unknown;
  try {
    value = JSON.parse(body.toString());
  } catch {
    throw new Error(`${provider} returned invalid JSON`);
  }

  const result = schema.safeParse(value);
  if (!result.success) {
    const fields = result.error.issues
      .slice(0, 5)
      .map((issue) => issue.path.join(".") || "(root)")
      .join(", ");
    throw new Error(`${provider} response does not match schema v${ORACLE_RESPONSE_SCHEMA_VERSION}: ${fields}`);
  }
  return result.data;
}
