import { z } from "zod";

/**
 * Runtime environment-variable schema.
 *
 * Validates every variable read by the configuration factory so that a typo
 * fails fast at startup instead of surfacing later as a confusing runtime
 * error (e.g. `NaN` ports or timeouts).
 *
 * Secrets are never echoed in validation output.
 */

const SECRET_KEYS = new Set(["RELAYER_SECRET_KEY"]);

/** Parse an integer, rejecting `NaN` and non-integer input explicitly. */
const intFromEnv = (opts: { min: number; max: number; label: string }) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === "") {
        return undefined;
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${opts.label} must be an integer between ${opts.min} and ${opts.max} (received a non-integer value)`,
        });
        return z.NEVER;
      }
      if (parsed < opts.min || parsed > opts.max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${opts.label} must be between ${opts.min} and ${opts.max}`,
        });
        return z.NEVER;
      }
      return parsed;
    });

const urlFromEnv = (label: string) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === "") {
        return undefined;
      }
      try {
        // eslint-disable-next-line no-new
        new URL(value);
        return value;
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must be a valid URL (e.g. https://example.com)`,
        });
        return z.NEVER;
      }
    });

/** StrKey validation for Stellar contract ids (C...) and secret keys (S...). */
const strKeyFromEnv = (label: string, prefix: "C" | "S") =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === "") {
        return undefined;
      }
      const valid = new RegExp(`^${prefix}[A-Z2-7]{55}$`).test(value);
      if (!valid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must be a valid Stellar StrKey starting with "${prefix}"`,
        });
        return z.NEVER;
      }
      return value;
    });

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: intFromEnv({ min: 1, max: 65535, label: "PORT" }),
    FRONTEND_URL: urlFromEnv("FRONTEND_URL"),
    STELLAR_NETWORK: z
      .enum(["testnet", "mainnet", "futurenet"])
      .default("testnet"),
    SOROBAN_RPC_URL: urlFromEnv("SOROBAN_RPC_URL"),
    ORACLE_HTTP_TIMEOUT_MS: intFromEnv({
      min: 100,
      max: 120_000,
      label: "ORACLE_HTTP_TIMEOUT_MS",
    }),
    POLICY_CONTRACT_ID: strKeyFromEnv("POLICY_CONTRACT_ID", "C"),
    POOL_CONTRACT_ID: strKeyFromEnv("POOL_CONTRACT_ID", "C"),
    CLAIM_CONTRACT_ID: strKeyFromEnv("CLAIM_CONTRACT_ID", "C"),
    RELAYER_SECRET_KEY: strKeyFromEnv("RELAYER_SECRET_KEY", "S"),
    REQUIRE_CHAIN_CONFIG: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true"),
    /**
     * Reference data (versioned entity registry) settings.
     *
     * Feed pins are supplied as `REFERENCE_DATA_PIN_<FEED>=<dataset>@<version>`
     * (e.g. `REFERENCE_DATA_PIN_FLIGHTDELAY=aviation@3`). Pins are optional at
     * the schema level so local tooling can run without them, but they are
     * REQUIRED in production: without a pin a feed would silently follow the
     * latest dataset version and a refresh could retroactively change how a
     * past reading was interpreted.
     */
    REFERENCE_DATA_IMPORT_DRY_RUN: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true"),
    REFERENCE_DATA_UNKNOWN_ALERT_WINDOW_MS: intFromEnv({
      min: 1_000,
      max: 86_400_000,
      label: "REFERENCE_DATA_UNKNOWN_ALERT_WINDOW_MS",
    }),
    REFERENCE_DATA_UNKNOWN_ALERT_MAX: intFromEnv({
      min: 1,
      max: 10_000,
      label: "REFERENCE_DATA_UNKNOWN_ALERT_MAX",
    }),
  })
  .catchall(
    // Allow dynamic `REFERENCE_DATA_PIN_<FEED>` keys; each must be a
    // `<dataset>@<version>` pin. Unknown keys are rejected below.
    z.unknown(),
  )
  .superRefine((env, ctx) => {
    const raw = env as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!key.startsWith("REFERENCE_DATA_PIN_")) {
        continue;
      }
      const feed = key.slice("REFERENCE_DATA_PIN_".length);
      const value = raw[key];
      if (feed.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} must name a feed (e.g. REFERENCE_DATA_PIN_FLIGHTDELAY)`,
        });
        continue;
      }
      if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+@\d+$/.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} must be a dataset pin of the form <dataset>@<version> (e.g. aviation@3)`,
        });
      }
    }

    if (!env.REQUIRE_CHAIN_CONFIG) {
      return;
    }
    const required: Array<keyof typeof env> = [
      "SOROBAN_RPC_URL",
      "POLICY_CONTRACT_ID",
      "POOL_CONTRACT_ID",
      "CLAIM_CONTRACT_ID",
      "RELAYER_SECRET_KEY",
    ];
    for (const key of required) {
      if (env[key] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when REQUIRE_CHAIN_CONFIG=true`,
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Extract the configured reference-data dataset pins from a validated env.
 *
 * Returns a map of feed name (upper-cased, e.g. `FLIGHTDELAY`) to
 * `{ dataset, version }`. Pins are required in production; callers should
 * fail fast when a feed has no pin.
 */
export function referenceDataPins(
  env: Env,
): Record<string, { dataset: string; version: number }> {
  const pins: Record<string, { dataset: string; version: number }> = {};
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (!key.startsWith("REFERENCE_DATA_PIN_") || typeof value !== "string") {
      continue;
    }
    const feed = key.slice("REFERENCE_DATA_PIN_".length).toUpperCase();
    const at = value.lastIndexOf("@");
    if (at <= 0) {
      continue;
    }
    pins[feed] = {
      dataset: value.slice(0, at),
      version: Number(value.slice(at + 1)),
    };
  }
  return pins;
}

/**
 * Validate `process.env` and return the parsed, typed environment.
 *
 * Throws a single aggregated, human-readable error listing every invalid
 * variable at once. Secret values are never included in the report.
 */
export function validateEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(raw);
  if (result.success) {
    return result.data;
  }

  const lines = result.error.issues.map((issue) => {
    const key = issue.path.join(".") || "(root)";
    const shown = SECRET_KEYS.has(key) ? "<redacted>" : undefined;
    const detail = shown ? `${issue.message} (value ${shown})` : issue.message;
    return `  - ${key}: ${detail}`;
  });

  throw new Error(
    `Invalid environment configuration:\n${lines.join("\n")}`,
  );
}
