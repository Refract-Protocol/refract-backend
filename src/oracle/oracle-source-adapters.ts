import { createHash } from "node:crypto";
import { z } from "zod";

export const PROVIDER_SCHEMA_DEPRECATION_DAYS = 90;
const providerAdapters = ["coingecko", "horizon", "defillama", "aviationstack"] as const;
export type ProviderAdapterId = (typeof providerAdapters)[number];

export interface ProviderDataPolicy {
  sensitivity: "public" | "commercial" | "personal";
  attribution: string;
  rawPayloadStorage: "transient_only" | "prohibited";
  publicApiPayload: "derived_only";
}

export interface CapturedProviderEvidence {
  adapter: ProviderAdapterId;
  schemaVersion: number;
  digest: string;
  attribution: string;
  policy: ProviderDataPolicy;
  payload: unknown;
}

const policies: Record<ProviderAdapterId, ProviderDataPolicy> = {
  coingecko: {
    sensitivity: "commercial",
    attribution: "CoinGecko",
    rawPayloadStorage: "transient_only",
    publicApiPayload: "derived_only",
  },
  horizon: {
    sensitivity: "public",
    attribution: "Stellar Horizon",
    rawPayloadStorage: "transient_only",
    publicApiPayload: "derived_only",
  },
  defillama: {
    sensitivity: "commercial",
    attribution: "DeFiLlama",
    rawPayloadStorage: "transient_only",
    publicApiPayload: "derived_only",
  },
  aviationstack: {
    sensitivity: "personal",
    attribution: "AviationStack (when configured)",
    rawPayloadStorage: "prohibited",
    publicApiPayload: "derived_only",
  },
};

const LEGACY_SCHEMA_RELEASED_AT = Date.parse("2026-10-20T00:00:00.000Z");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Provider changes are normalized here before any value can be persisted or
 * exposed. Version 0 is the legacy axios `{ data: payload }` envelope.
 */
export function captureProviderPayload(
  adapter: ProviderAdapterId,
  payload: unknown,
  options: { schemaVersion?: number; strict?: boolean; now?: number } = {},
): CapturedProviderEvidence {
  const schemaVersion = options.schemaVersion ?? 1;
  const now = options.now ?? Date.now();
  let normalized = payload;

  if (schemaVersion === 0) {
    const deprecationDeadline =
      LEGACY_SCHEMA_RELEASED_AT + PROVIDER_SCHEMA_DEPRECATION_DAYS * 24 * 60 * 60 * 1000;
    if (now > deprecationDeadline) {
      throw new Error(`${adapter} schema version 0 has passed its deprecation window`);
    }
    if (!payload || typeof payload !== "object" || !("data" in payload)) {
      throw new Error(`${adapter} schema version 0 requires the legacy data envelope`);
    }
    normalized = (payload as { data: unknown }).data;
  } else if (schemaVersion !== 1) {
    throw new Error(`Unsupported ${adapter} schema version ${schemaVersion}`);
  }

  const schema = buildSchema(adapter, options.strict ?? false);
  const parsed = schema.parse(normalized);
  if (
    adapter === "coingecko" &&
    !(parsed as { "usd-coin"?: unknown; stellar?: unknown })["usd-coin"] &&
    !(parsed as { stellar?: unknown }).stellar
  ) {
    throw new Error("CoinGecko payload must contain usd-coin or stellar data");
  }
  const attribution = policies[adapter].attribution;
  const digest = sha256(JSON.stringify(parsed));

  return {
    adapter,
    schemaVersion,
    digest,
    attribution,
    policy: policies[adapter],
    payload: parsed,
  };
}

function buildSchema(adapter: ProviderAdapterId, strict: boolean): z.ZodTypeAny {
  const object = <T extends z.ZodRawShape>(shape: T) =>
    strict ? z.object(shape).strict() : z.object(shape);

  switch (adapter) {
    case "coingecko":
      return object({
        "usd-coin": object({ usd: z.number().finite() }).optional(),
        stellar: object({
          usd: z.number().finite(),
          usd_24h_change: z.number().finite(),
        }).optional(),
      });
    case "horizon":
      return object({
        _embedded: object({
          records: z.array(
            object({ sequence: z.number().int(), closed_at: z.string() }),
          ),
        }),
      });
    case "defillama":
      return object({
        name: z.string().optional(),
        tvl: z.array(
          object({ date: z.number().int(), totalLiquidityUSD: z.number().finite() }),
        ),
      });
    case "aviationstack":
      return object({
        flight: object({
          iata: z.string(),
          delay: z.number().finite().nullable().optional(),
        }),
      });
  }
}
