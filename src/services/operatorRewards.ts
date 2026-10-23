import { createHash } from 'crypto';

/**
 * Operator reward accrual and distribution for honest oracle participation.
 *
 * Accruals are derived from the committed evidence ledger (not live submission
 * events) so they are recomputable and auditable after the fact. Only readings
 * that were included in a committed consensus decision accrue rewards; late,
 * quarantined, duplicated, or later-invalidated readings accrue nothing.
 *
 * Formula (documented):
 *   base       = CONSENSUS_BASE_REWARD
 *   stakeW     = min(stake, STAKE_CAP) / STAKE_CAP        (0..1)
 *   repW       = clamp(reputation, 0, 1)                  (0..1)
 *   weight     = stakeW * repW
 *   raw        = base * weight
 *   capped     = min(raw, POOL_CAP_PER_OPERATOR)          (anti-domination)
 *   accrual    = round(capped, DUST_PRECISION)
 *
 * Operators with zero stake accrue nothing (weight is zero). Rounding dust is
 * truncated to DUST_PRECISION and never redistributed, keeping accruals
 * deterministic for a fixed set of consensus inputs.
 */

export const CONSENSUS_BASE_REWARD = 100;
export const STAKE_CAP = 100_000;
export const POOL_CAP_PER_OPERATOR = 250;
export const DUST_PRECISION = 6;
export const MIN_PAYOUT_THRESHOLD = 10;
export const DISPUTE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ReadingStatus =
  | 'committed'
  | 'late'
  | 'quarantined'
  | 'duplicate'
  | 'invalidated';

export interface ConsensusReading {
  /** Stable id of the reading in the evidence ledger. */
  readingId: string;
  /** Round the reading was submitted for. */
  roundId: string;
  operatorId: string;
  /** Whether the reading was included in the committed consensus decision. */
  includedInConsensus: boolean;
  /** Lifecycle status of the reading. */
  status: ReadingStatus;
  /** Operator stake at accrual time. */
  stake: number;
  /** Operator reputation score in [0, 1]. */
  reputation: number;
}

export interface RewardAccrual {
  /** Idempotency key: unique per (roundId, readingId, operatorId). */
  idempotencyKey: string;
  roundId: string;
  readingId: string;
  operatorId: string;
  amount: number;
  createdAt: number;
}

export type LedgerEntryType = 'accrual' | 'adjustment' | 'payout';

export interface LedgerEntry {
  idempotencyKey: string;
  type: LedgerEntryType;
  operatorId: string;
  amount: number;
  roundId?: string;
  readingId?: string;
  createdAt: number;
}

export interface PayoutRecord {
  idempotencyKey: string;
  operatorId: string;
  amount: number;
  scheduledAt: number;
  disputeWindowEndsAt: number;
  status: 'pending' | 'paid' | 'disputed';
}

export interface OperatorRewardView {
  operatorId: string;
  accrued: number;
  pending: number;
  paid: number;
}

export interface RewardLedgerStore {
  hasEntry(idempotencyKey: string): boolean;
  appendEntry(entry: LedgerEntry): void;
  listEntries(operatorId?: string): LedgerEntry[];
  listPayouts(operatorId?: string): PayoutRecord[];
  upsertPayout(payout: PayoutRecord): void;
}

export class InMemoryRewardLedgerStore implements RewardLedgerStore {
  private entries = new Map<string, LedgerEntry>();
  private payouts = new Map<string, PayoutRecord>();

  hasEntry(idempotencyKey: string): boolean {
    return this.entries.has(idempotencyKey);
  }

  appendEntry(entry: LedgerEntry): void {
    if (this.entries.has(entry.idempotencyKey)) return;
    this.entries.set(entry.idempotencyKey, entry);
  }

  listEntries(operatorId?: string): LedgerEntry[] {
    const all = Array.from(this.entries.values());
    return operatorId ? all.filter((e) => e.operatorId === operatorId) : all;
  }

  listPayouts(operatorId?: string): PayoutRecord[] {
    const all = Array.from(this.payouts.values());
    return operatorId ? all.filter((p) => p.operatorId === operatorId) : all;
  }

  upsertPayout(payout: PayoutRecord): void {
    this.payouts.set(payout.idempotencyKey, payout);
  }
}

function roundDust(value: number): number {
  const factor = Math.pow(10, DUST_PRECISION);
  return Math.floor(value * factor) / factor;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Compute the reward weight for an operator from stake and reputation.
 * Zero stake yields zero weight, so zero-stake operators accrue nothing.
 */
export function computeRewardWeight(stake: number, reputation: number): number {
  if (!Number.isFinite(stake) || stake <= 0) return 0;
  const stakeW = Math.min(stake, STAKE_CAP) / STAKE_CAP;
  const repW = clamp01(reputation);
  return stakeW * repW;
}

/**
 * Compute the accrual amount for a single reading, applying the per-operator
 * pool cap and dust rounding. Returns 0 for readings that must not accrue.
 */
export function computeAccrualAmount(reading: ConsensusReading): number {
  if (!reading.includedInConsensus) return 0;
  if (reading.status !== 'committed') return 0;
  const weight = computeRewardWeight(reading.stake, reading.reputation);
  if (weight <= 0) return 0;
  const raw = CONSENSUS_BASE_REWARD * weight;
  const capped = Math.min(raw, POOL_CAP_PER_OPERATOR);
  return roundDust(capped);
}

/**
 * Deterministic idempotency key for an accrual. Stable across retries and
 * re-orgs because it is derived from the committed ledger coordinates.
 */
export function accrualIdempotencyKey(
  roundId: string,
  readingId: string,
  operatorId: string,
): string {
  return createHash('sha256')
    .update(`accrual:${roundId}:${readingId}:${operatorId}`)
    .digest('hex');
}

/**
 * Accrue rewards for a set of committed consensus readings. Exactly-once under
 * retries: duplicate deliveries are skipped via the idempotency key.
 */
export function accrueRewards(
  store: RewardLedgerStore,
  readings: ConsensusReading[],
  now: number = Date.now(),
): RewardAccrual[] {
  const accrued: RewardAccrual[] = [];
  for (const reading of readings) {
    const amount = computeAccrualAmount(reading);
    if (amount <= 0) continue;
    const idempotencyKey = accrualIdempotencyKey(
      reading.roundId,
      reading.readingId,
      reading.operatorId,
    );
    if (store.hasEntry(idempotencyKey)) continue;
    const entry: LedgerEntry = {
      idempotencyKey,
      type: 'accrual',
      operatorId: reading.operatorId,
      amount,
      roundId: reading.roundId,
      readingId: reading.readingId,
      createdAt: now,
    };
    store.appendEntry(entry);
    accrued.push({
      idempotencyKey,
      roundId: reading.roundId,
      readingId: reading.readingId,
      operatorId: reading.operatorId,
      amount,
      createdAt: now,
    });
  }
  return accrued;
}

/**
 * Reverse an accrual when a reading is later invalidated by remediation. The
 * adjustment is idempotent and only applied if the original accrual exists.
 */
export function invalidateAccrual(
  store: RewardLedgerStore,
  roundId: string,
  readingId: string,
  operatorId: string,
  now: number = Date.now(),
): LedgerEntry | null {
  const accrualKey = accrualIdempotencyKey(roundId, readingId, operatorId);
  if (!store.hasEntry(accrualKey)) return null;
  const adjustmentKey = createHash('sha256')
    .update(`adjustment:${accrualKey}`)
    .digest('hex');
  if (store.hasEntry(adjustmentKey)) return null;
  const original = store
    .listEntries(operatorId)
    .find((e) => e.idempotencyKey === accrualKey);
  if (!original) return null;
  const entry: LedgerEntry = {
    idempotencyKey: adjustmentKey,
    type: 'adjustment',
    operatorId,
    amount: -original.amount,
    roundId,
    readingId,
    createdAt: now,
  };
  store.appendEntry(entry);
  return entry;
}

/**
 * Schedule payouts for operators whose accrued balance meets the minimum
 * threshold. Funds move only after the dispute window elapses.
 */
export function schedulePayouts(
  store: RewardLedgerStore,
  now: number = Date.now(),
): PayoutRecord[] {
  const balances = new Map<string, number>();
  for (const entry of store.listEntries()) {
    if (entry.type === 'payout') continue;
    balances.set(entry.operatorId, (balances.get(entry.operatorId) ?? 0) + entry.amount);
  }

  const scheduled: PayoutRecord[] = [];
  for (const [operatorId, balance] of balances) {
    if (balance < MIN_PAYOUT_THRESHOLD) continue;
    const idempotencyKey = createHash('sha256')
      .update(`payout:${operatorId}:${roundDust(balance)}`)
      .digest('hex');
    const existing = store
      .listPayouts(operatorId)
      .find((p) => p.idempotencyKey === idempotencyKey);
    if (existing) continue;
    const payout: PayoutRecord = {
      idempotencyKey,
      operatorId,
      amount: roundDust(balance),
      scheduledAt: now,
      disputeWindowEndsAt: now + DISPUTE_WINDOW_MS,
      status: 'pending',
    };
    store.upsertPayout(payout);
    scheduled.push(payout);
  }
  return scheduled;
}

/**
 * Settle pending payouts whose dispute window has elapsed. Disputed payouts are
 * left untouched.
 */
export function settlePayouts(
  store: RewardLedgerStore,
  now: number = Date.now(),
): PayoutRecord[] {
  const settled: PayoutRecord[] = [];
  for (const payout of store.listPayouts()) {
    if (payout.status !== 'pending') continue;
    if (now < payout.disputeWindowEndsAt) continue;
    const entry: LedgerEntry = {
      idempotencyKey: payout.idempotencyKey,
      type: 'payout',
      operatorId: payout.operatorId,
      amount: -payout.amount,
      createdAt: now,
    };
    if (!store.hasEntry(entry.idempotencyKey)) {
      store.appendEntry(entry);
    }
    const paid: PayoutRecord = { ...payout, status: 'paid' };
    store.upsertPayout(paid);
    settled.push(paid);
  }
  return settled;
}

/**
 * Operator-facing view of accrued, pending, and paid rewards.
 */
export function getOperatorRewardView(
  store: RewardLedgerStore,
  operatorId: string,
): OperatorRewardView {
  let accrued = 0;
  let paid = 0;
  for (const entry of store.listEntries(operatorId)) {
    if (entry.type === 'accrual' || entry.type === 'adjustment') {
      accrued += entry.amount;
    } else if (entry.type === 'payout') {
      paid += -entry.amount;
    }
  }
  const pending = Math.max(0, roundDust(accrued - paid));
  return {
    operatorId,
    accrued: roundDust(accrued),
    pending,
    paid: roundDust(paid),
  };
}
