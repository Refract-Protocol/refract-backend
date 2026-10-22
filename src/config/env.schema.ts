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

/** Parse a decimal number (integer or fractional), rejecting `NaN`. */
const decimalFromEnv = (opts: { min: number; max: number; label: string }) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === "") {
        return undefined;
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${opts.label} must be a finite number between ${opts.min} and ${opts.max}`,
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

/** Parse a boolean flag expressed as "true"/"false". */
const boolFromEnv = (label: string) =>
  z
    .enum(["true", "false"])
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) {
        return undefined;
      }
      if (value !== "true" && value !== "false") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must be "true" or "false"`,
        });
        return z.NEVER;
      }
      return value === "true";
    });

/** Parse a comma-separated list of non-empty trimmed strings. */
const csvFromEnv = (label: string) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === "") {
        return undefined;
      }
      const items = value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      if (items.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must contain at least one non-empty entry`,
        });
        return z.NEVER;
      }
      return items;
    });

/** Validate an IANA time zone identifier against the runtime's tz database. */
const timeZoneFromEnv = (label: string) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === "") {
        return undefined;
      }
      try {
        // eslint-disable-next-line no-new
        new Intl.DateTimeFormat("en-US", { timeZone: value });
        return value;
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must be a valid IANA time zone (e.g. America/New_York)`,
        });
        return z.NEVER;
      }
    });
=======

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

    // --- Attack-cost model (#288) -------------------------------------------
    /** Path to the feed definition + quorum policy used by the CLI/validator. */
    FEED_DEFINITION_PATH: z
      .string()
      .optional()
      .transform((value) => (value === "" ? undefined : value)),
    /** Multiplier applied to modeled attack cost to derive max exposure. */
    ATTACK_COST_SAFETY_FACTOR: decimalFromEnv({
      min: 1,
      max: 1_000,
      label: "ATTACK_COST_SAFETY_FACTOR",
    }),
    /** Refuse to start when exposure exceeds the modeled attack cost bound. */
    ENFORCE_ATTACK_COST_BOUND: boolFromEnv("ENFORCE_ATTACK_COST_BOUND"),

    // --- Calendar / clock awareness (#291) ----------------------------------
    /** Identifier of the holiday calendar source (data shipped separately). */
    FEED_CALENDAR_SOURCE: z
      .string()
      .optional()
      .transform((value) => (value === "" ? undefined : value)),
    /** Default IANA time zone for feeds without an explicit declaration. */
    FEED_CALENDAR_TIME_ZONE: timeZoneFromEnv("FEED_CALENDAR_TIME_ZONE"),
    /** Behavior when a feed is inside a scheduled quiet period. */
    FEED_QUIET_PERIOD_BEHAVIOR: z
      .enum(["suspend", "relax", "strict"])
      .optional(),
    /** Fail-safe mode when the calendar is unavailable at startup. */
    FEED_CALENDAR_UNAVAILABLE_MODE: z
      .enum(["closed", "open", "fail"])
      .optional(),
    /** Bounded grace period (ms) before an unscheduled halt alerts. */
    FEED_UNSCHEDULED_HALT_GRACE_MS: intFromEnv({
      min: 0,
      max: 86_400_000,
      label: "FEED_UNSCHEDULED_HALT_GRACE_MS",
    }),

    // --- TEE attestation (#293) ---------------------------------------------
    /** Enable verification of TEE-attested provider readings. */
    TEE_ATTESTATION_ENABLED: boolFromEnv("TEE_ATTESTATION_ENABLED"),
    /** Pinned vendor root (PEM or URL) used to validate quotes. */
    TEE_VENDOR_ROOT: z
      .string()
      .optional()
      .transform((value) => (value === "" ? undefined : value)),
    /** Allowlisted enclave measurements (comma-separated hex digests). */
    TEE_ALLOWED_MEASUREMENTS: csvFromEnv("TEE_ALLOWED_MEASUREMENTS"),
    /** Maximum accepted quote size in bytes. */
    TEE_MAX_QUOTE_BYTES: intFromEnv({
      min: 1,
      max: 1_048_576,
      label: "TEE_MAX_QUOTE_BYTES",
    }),
  })
  .superRefine((env, ctx) => {
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
  })
  .superRefine((env, ctx) => {
    // Attack-cost enforcement needs both a feed definition and a safety factor.
    if (env.ENFORCE_ATTACK_COST_BOUND) {
      if (env.FEED_DEFINITION_PATH === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["FEED_DEFINITION_PATH"],
          message:
            "FEED_DEFINITION_PATH is required when ENFORCE_ATTACK_COST_BOUND=true",
        });
      }
      if (env.ATTACK_COST_SAFETY_FACTOR === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ATTACK_COST_SAFETY_FACTOR"],
          message:
            "ATTACK_COST_SAFETY_FACTOR is required when ENFORCE_ATTACK_COST_BOUND=true",
        });
      }
    }

    // TEE attestation requires a pinned root and at least one measurement.
    if (env.TEE_ATTESTATION_ENABLED) {
      if (env.TEE_VENDOR_ROOT === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["TEE_VENDOR_ROOT"],
          message: "TEE_VENDOR_ROOT is required when TEE_ATTESTATION_ENABLED=true",
        });
      }
      if (
        env.TEE_ALLOWED_MEASUREMENTS === undefined ||
        env.TEE_ALLOWED_MEASUREMENTS.length === 0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["TEE_ALLOWED_MEASUREMENTS"],
          message:
            "TEE_ALLOWED_MEASUREMENTS is required when TEE_ATTESTATION_ENABLED=true",
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

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
