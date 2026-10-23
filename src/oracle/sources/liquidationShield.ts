/**
 * NEXUS Protocol liquidation adapter for LiquidationShield.
 *
 * This module does not decode the NEXUS contract's event stream. Callers pass
 * in liquidation events that were already decoded from on-chain data. It only
 * decides which of those events are final enough to count toward a reading.
 *
 * Fail-closed: an empty, unconfirmed, or malformed input yields no confirmed
 * events. It never yields a zero reading, so an outage cannot look like "no
 * liquidation" or trigger a payout.
 */

/** Ledgers that must close after an event before it is considered final. */
export const LIQUIDATION_CONFIRMATION_DEPTH = 12;

export interface NexusLiquidationEvent {
  /** Stable event identifier from the RPC event stream (used for dedupe). */
  eventId: string;
  ledger: number;
  txHash: string;
}

/**
 * True when `eventLedger` is at least `depth` ledgers behind `latestLedger`.
 * Any non-integer or non-positive ledger number is treated as unconfirmed.
 */
export function isLedgerConfirmed(
  eventLedger: number,
  latestLedger: number,
  depth: number = LIQUIDATION_CONFIRMATION_DEPTH,
): boolean {
  if (!Number.isSafeInteger(eventLedger) || eventLedger <= 0) return false;
  if (!Number.isSafeInteger(latestLedger)) return false;
  return latestLedger - eventLedger >= depth;
}

/**
 * Returns the confirmed liquidation events, in input order, with duplicate
 * `eventId`s collapsed to their first occurrence. Unconfirmed events are
 * dropped and are not remembered, so they can be re-evaluated on a later tick.
 */
export function selectConfirmedLiquidations(
  events: readonly NexusLiquidationEvent[],
  latestLedger: number,
  depth: number = LIQUIDATION_CONFIRMATION_DEPTH,
): NexusLiquidationEvent[] {
  const seen = new Set<string>();
  const confirmed: NexusLiquidationEvent[] = [];

  for (const event of events) {
    if (seen.has(event.eventId)) continue;
    if (!isLedgerConfirmed(event.ledger, latestLedger, depth)) continue;
    seen.add(event.eventId);
    confirmed.push(event);
  }

  return confirmed;
}
