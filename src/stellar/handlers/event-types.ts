/**
 * Shared types for Soroban contract-event handlers.
 *
 * Assumed Refract-style topic naming (Symbol names after scValToNative):
 *   - "policy_purchased"
 *   - "capital_provided"
 *   - "capital_withdrawn"
 *   - "claim_processed"
 *
 * Contracts may also emit a contract-namespace prefix as topic[0] (e.g.
 * "refract") with the event name as topic[1]. Handlers accept either shape
 * via {@link extractEventTopicName}.
 */

export const EVENT_TOPICS = {
  POLICY_PURCHASED: "policy_purchased",
  CAPITAL_PROVIDED: "capital_provided",
  CAPITAL_WITHDRAWN: "capital_withdrawn",
  CLAIM_PROCESSED: "claim_processed",
} as const;

export type KnownEventTopic = (typeof EVENT_TOPICS)[keyof typeof EVENT_TOPICS];

export interface DecodedContractEvent {
  eventId: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  txHash: string;
  /** Topics decoded with scValToNative (typically Symbol → string). */
  topics: unknown[];
  /** Event value decoded with scValToNative (Map → object, i128 → bigint). */
  value: unknown;
}

/** Pull the event-name Symbol from topics[0] or topics[1]. */
export function extractEventTopicName(topics: unknown[]): string | null {
  for (const t of topics) {
    if (typeof t === "string" && t in TOPIC_SET) {
      return t;
    }
  }
  // Prefer the last string topic if none matched known names (forward compat).
  for (let i = topics.length - 1; i >= 0; i--) {
    if (typeof topics[i] === "string") {
      return topics[i] as string;
    }
  }
  return null;
}

const TOPIC_SET: Record<string, true> = {
  [EVENT_TOPICS.POLICY_PURCHASED]: true,
  [EVENT_TOPICS.CAPITAL_PROVIDED]: true,
  [EVENT_TOPICS.CAPITAL_WITHDRAWN]: true,
  [EVENT_TOPICS.CLAIM_PROCESSED]: true,
};

/** Coerce scValToNative i128 / number / string into bigint. */
export function asBigInt(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string" && value.length > 0) return BigInt(value);
  throw new Error(`Expected bigint-compatible value for ${field}, got ${typeof value}`);
}

export function asString(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return value.toString();
  // Stellar Address objects sometimes surface with toString().
  if (value && typeof (value as { toString?: () => string }).toString === "function") {
    return (value as { toString: () => string }).toString();
  }
  throw new Error(`Expected string for ${field}, got ${typeof value}`);
}

export function asNumber(value: unknown, field: string): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.length > 0) return Number(value);
  throw new Error(`Expected number for ${field}, got ${typeof value}`);
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`Expected event value object, got ${typeof value}`);
}

/** Map coverage_type from enum-name string, ordinal, or one-element vec. */
export function asCoverageTypeOrdinal(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const byName: Record<string, number> = {
      StablecoinDepeg: 0,
      stablecoin_depeg: 0,
      MarketCrash: 1,
      market_crash: 1,
      LiquidationShield: 2,
      liquidation_shield: 2,
      SmartContractRisk: 3,
      smart_contract_risk: 3,
      FlightDelay: 4,
      flight_delay: 4,
    };
    if (value in byName) return byName[value];
    const n = Number(value);
    if (!Number.isNaN(n)) return n;
  }
  if (Array.isArray(value) && value.length > 0) {
    return asCoverageTypeOrdinal(value[0]);
  }
  throw new Error(`Unable to parse coverage_type from ${JSON.stringify(value)}`);
}
