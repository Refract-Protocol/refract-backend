import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PoolClient } from "pg";
import { DbService } from "../db/db.service";

export type FeedTier = "tier1" | "tier2" | "tier3";
export type SlashReason = "outside_tolerance" | "post_quarantine" | "equivocation";
export type ProposalStatus = "pending_review" | "pending_appeal" | "approved" | "rejected" | "executed";

export const FEED_TIERS: readonly FeedTier[] = ["tier1", "tier2", "tier3"];
export const BPS_DENOMINATOR = 10_000n;

const DAY_SECONDS = 86_400;
const STROOPS_PER_UNIT = 10n ** 7n;
const OPEN_PROPOSAL_STATUSES: readonly ProposalStatus[] = ["pending_review", "pending_appeal", "approved"];

export interface StakingPolicy {
  unbondingPeriodSeconds: number;
  minBondAgeSeconds: number;
  /** Minimum bonded amount (base units) required to serve each feed tier. */
  minBondByTier: Record<FeedTier, bigint>;
  /** Slash rate per reason, in basis points of the stake at risk. */
  slashBps: Record<SlashReason, number>;
  /** Bounded auto-slash: only reasons with slashBps <= maxBps are auto-proposed, with an appeal window. */
  autoSlash: { enabled: boolean; maxBps: number; appealWindowSeconds: number };
}

const unsignedInt = (env: NodeJS.ProcessEnv, key: string, fallback: number): number => {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a non-negative integer`);
  return Number(raw);
};

const unsignedBigInt = (env: NodeJS.ProcessEnv, key: string, fallback: bigint): bigint => {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a non-negative integer in base units`);
  return BigInt(raw);
};

/**
 * Resolves the staking policy from env, falling back to the defaults documented
 * in docs/staking-policy.md. Takes `env` so it can be exercised without mutating
 * process state.
 */
export function loadStakingPolicy(env: NodeJS.ProcessEnv = process.env): StakingPolicy {
  return {
    unbondingPeriodSeconds: unsignedInt(env, "STAKING_UNBONDING_PERIOD_SECONDS", 14 * DAY_SECONDS),
    minBondAgeSeconds: unsignedInt(env, "STAKING_MIN_BOND_AGE_SECONDS", 7 * DAY_SECONDS),
    minBondByTier: {
      tier1: unsignedBigInt(env, "STAKING_MIN_BOND_TIER1", 50_000n * STROOPS_PER_UNIT),
      tier2: unsignedBigInt(env, "STAKING_MIN_BOND_TIER2", 25_000n * STROOPS_PER_UNIT),
      tier3: unsignedBigInt(env, "STAKING_MIN_BOND_TIER3", 10_000n * STROOPS_PER_UNIT),
    },
    slashBps: {
      outside_tolerance: unsignedInt(env, "STAKING_SLASH_BPS_OUTSIDE_TOLERANCE", 500),
      post_quarantine: unsignedInt(env, "STAKING_SLASH_BPS_POST_QUARANTINE", 1000),
      equivocation: unsignedInt(env, "STAKING_SLASH_BPS_EQUIVOCATION", 2500),
    },
    autoSlash: {
      enabled: (env.STAKING_AUTO_SLASH_ENABLED ?? "").trim().toLowerCase() === "true",
      maxBps: unsignedInt(env, "STAKING_AUTO_SLASH_MAX_BPS", 500),
      appealWindowSeconds: unsignedInt(env, "STAKING_APPEAL_WINDOW_SECONDS", 3 * DAY_SECONDS),
    },
  };
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/**
 * Slash amount for a stake at risk. Floor division, capped at the stake, so
 * rounding can never over-slash.
 */
export function slashAmountFor(atStake: bigint, bps: number): bigint {
  if (atStake <= 0n || bps <= 0) return 0n;
  return min((atStake * BigInt(bps)) / BPS_DENOMINATOR, atStake);
}

export interface UnbondingLot {
  id: string;
  amount: bigint;
}

/**
 * Splits a slash across bonded stake first, then unbonding lots in request order.
 * Unbonding never shields stake from an in-flight proposal.
 */
export function allocateSlash(
  bonded: bigint,
  unbonding: readonly UnbondingLot[],
  amount: bigint,
): { fromBonded: bigint; fromUnbonding: Map<string, bigint> } {
  let remaining = amount;
  const fromBonded = min(bonded, remaining);
  remaining -= fromBonded;

  const fromUnbonding = new Map<string, bigint>();
  for (const lot of unbonding) {
    if (remaining === 0n) break;
    const take = min(lot.amount, remaining);
    if (take > 0n) fromUnbonding.set(lot.id, take);
    remaining -= take;
  }

  if (remaining !== 0n) throw new Error("slash amount exceeds stake at risk");
  return { fromBonded, fromUnbonding };
}

/** True when the bond meets the tier minimum and has aged past the minimum bond age. */
export function isBondEligible(
  bonded: bigint,
  firstBondedAt: Date | null,
  tierMinimum: bigint,
  minBondAgeSeconds: number,
  now: Date,
): boolean {
  if (!firstBondedAt || bonded < tierMinimum) return false;
  return now.getTime() - firstBondedAt.getTime() >= minBondAgeSeconds * 1000;
}

export interface OracleSubmission {
  evidenceId: string;
  operatorId: string;
  feedId: string;
  roundId: string;
  value: bigint;
  submittedAt: Date;
}

export interface SubmissionContext {
  /** Corroborated consensus value for the round, or null when none exists. */
  consensus: bigint | null;
  toleranceBps: number;
  /** When the operator was quarantined, or null when not quarantined. */
  quarantinedAt: Date | null;
}

export interface SlashableFinding {
  reason: SlashReason;
  evidenceIds: string[];
}

/**
 * Classifies slashable conditions for one submission. `siblings` are other
 * submissions for the same round, used to detect equivocation.
 */
export function detectSlashableConditions(
  submission: OracleSubmission,
  siblings: readonly OracleSubmission[],
  context: SubmissionContext,
): SlashableFinding[] {
  const findings: SlashableFinding[] = [];

  if (context.consensus !== null && context.consensus > 0n) {
    const diff =
      submission.value > context.consensus
        ? submission.value - context.consensus
        : context.consensus - submission.value;
    if (diff * BPS_DENOMINATOR > context.consensus * BigInt(context.toleranceBps)) {
      findings.push({ reason: "outside_tolerance", evidenceIds: [submission.evidenceId] });
    }
  }

  if (context.quarantinedAt && submission.submittedAt > context.quarantinedAt) {
    findings.push({ reason: "post_quarantine", evidenceIds: [submission.evidenceId] });
  }

  for (const other of siblings) {
    if (
      other.evidenceId !== submission.evidenceId &&
      other.operatorId === submission.operatorId &&
      other.feedId === submission.feedId &&
      other.roundId === submission.roundId &&
      other.value !== submission.value
    ) {
      findings.push({
        reason: "equivocation",
        evidenceIds: [submission.evidenceId, other.evidenceId].sort(),
      });
    }
  }

  return findings;
}

interface BondRow {
  operator_id: string;
  bonded_amount: string;
  first_bonded_at: Date | null;
}

interface UnbondRow {
  id: string;
  amount: string;
  available_at: Date;
}

interface ProposalRow {
  id: string;
  operator_id: string;
  reason: SlashReason;
  evidence_ids: string[];
  amount: string;
  status: ProposalStatus;
  appeal_until: Date | null;
  execution_tx_hash: string | null;
}

export interface ProposalView {
  id: string;
  operatorId: string;
  reason: SlashReason;
  evidenceIds: string[];
  amount: string;
  status: ProposalStatus;
  appealUntil: string | null;
  executionTxHash: string | null;
}

const toProposalView = (row: ProposalRow): ProposalView => ({
  id: row.id,
  operatorId: row.operator_id,
  reason: row.reason,
  evidenceIds: row.evidence_ids,
  amount: row.amount,
  status: row.status,
  appealUntil: row.appeal_until?.toISOString() ?? null,
  executionTxHash: row.execution_tx_hash,
});

export const parseAmount = (value: unknown, field: string): bigint => {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new BadRequestException(`${field} must be a positive integer string in base units`);
  }
  return BigInt(value);
};

/**
 * Bond, unbond, withdraw and slashing state machine for oracle operators.
 *
 * Every state change locks the operator's bond row first, so concurrent bond,
 * unbond, withdraw and slash operations for one operator are serialized.
 */
@Injectable()
export class StakingService {
  private readonly policy = loadStakingPolicy();

  constructor(private readonly db: DbService) {}

  /** Operator-facing view: bond, unbonding lots with remaining time, and open slashing proposals. */
  async getStatus(operatorId: string, now: Date = new Date()) {
    const bondResult = await this.db.query<BondRow>(
      "SELECT operator_id, bonded_amount, first_bonded_at FROM operator_bonds WHERE operator_id = $1",
      [operatorId],
    );
    const bond = bondResult.rows[0];
    const bonded = bond ? BigInt(bond.bonded_amount) : 0n;

    const unbondResult = await this.db.query<UnbondRow>(
      `SELECT id, amount, available_at FROM unbond_requests
       WHERE operator_id = $1 AND status = 'unbonding' ORDER BY requested_at`,
      [operatorId],
    );

    const proposalResult = await this.db.query<ProposalRow>(
      `SELECT id, operator_id, reason, evidence_ids, amount, status, appeal_until, execution_tx_hash
       FROM slashing_proposals WHERE operator_id = $1 AND status = ANY($2::text[])
       ORDER BY created_at`,
      [operatorId, OPEN_PROPOSAL_STATUSES],
    );

    return {
      operatorId,
      bondedAmount: bonded.toString(),
      eligibleTiers: FEED_TIERS.filter((tier) =>
        isBondEligible(
          bonded,
          bond?.first_bonded_at ?? null,
          this.policy.minBondByTier[tier],
          this.policy.minBondAgeSeconds,
          now,
        ),
      ),
      unbonding: unbondResult.rows.map((row) => ({
        id: row.id,
        amount: row.amount,
        availableAt: row.available_at.toISOString(),
        remainingSeconds: Math.max(0, Math.ceil((row.available_at.getTime() - now.getTime()) / 1000)),
      })),
      pendingSlashing: proposalResult.rows.map(toProposalView),
    };
  }

  /**
   * Records a confirmed on-chain bond. Bond age is anchored to the first bond,
   * so top-ups do not reset it.
   */
  async recordBond(operatorId: string, amountInput: unknown): Promise<void> {
    const amount = parseAmount(amountInput, "amount");
    await this.db.query(
      `INSERT INTO operator_bonds (operator_id, bonded_amount, first_bonded_at)
       VALUES ($1, $2, now())
       ON CONFLICT (operator_id) DO UPDATE SET
         bonded_amount = operator_bonds.bonded_amount + EXCLUDED.bonded_amount,
         first_bonded_at = COALESCE(operator_bonds.first_bonded_at, now()),
         updated_at = now()`,
      [operatorId, amount.toString()],
    );
  }

  /**
   * Moves bonded stake into an unbonding lot. The lot stays slashable until
   * withdrawn, and the operator drops out of tiers it no longer meets right away.
   */
  async requestUnbond(operatorId: string, amountInput: unknown): Promise<{ id: string; availableAt: string }> {
    const amount = parseAmount(amountInput, "amount");
    return this.withTransaction(async (client) => {
      const bond = await this.lockBond(client, operatorId);
      if (amount > BigInt(bond.bonded_amount)) {
        throw new ConflictException("unbond amount exceeds bonded stake");
      }
      await client.query(
        "UPDATE operator_bonds SET bonded_amount = bonded_amount - $2, updated_at = now() WHERE operator_id = $1",
        [operatorId, amount.toString()],
      );
      const result = await client.query<UnbondRow>(
        `INSERT INTO unbond_requests (operator_id, amount, available_at)
         VALUES ($1, $2, now() + make_interval(secs => $3))
         RETURNING id, amount, available_at`,
        [operatorId, amount.toString(), this.policy.unbondingPeriodSeconds],
      );
      return { id: result.rows[0].id, availableAt: result.rows[0].available_at.toISOString() };
    });
  }

  /**
   * Releases unbonding lots whose period has elapsed. Blocked while any slashing
   * proposal for the operator is open, so funds cannot leave ahead of a dispute.
   */
  async withdraw(operatorId: string): Promise<{ withdrawn: string }> {
    return this.withTransaction(async (client) => {
      await this.lockBond(client, operatorId);
      const open = await client.query(
        "SELECT 1 FROM slashing_proposals WHERE operator_id = $1 AND status = ANY($2::text[]) LIMIT 1",
        [operatorId, OPEN_PROPOSAL_STATUSES],
      );
      if (open.rowCount) {
        throw new ConflictException("withdrawal blocked by an open slashing proposal");
      }
      const result = await client.query<UnbondRow>(
        `UPDATE unbond_requests SET status = 'withdrawn', withdrawn_at = now()
         WHERE operator_id = $1 AND status = 'unbonding' AND available_at <= now()
         RETURNING id, amount, available_at`,
        [operatorId],
      );
      const total = result.rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
      return { withdrawn: total.toString() };
    });
  }

  /**
   * Classifies one submission and opens a proposal per finding. Returns only the
   * proposals created here; repeat evaluations of the same evidence return none.
   */
  async evaluateSubmission(
    submission: OracleSubmission,
    siblings: readonly OracleSubmission[],
    context: SubmissionContext,
  ): Promise<ProposalView[]> {
    const created: ProposalView[] = [];
    for (const finding of detectSlashableConditions(submission, siblings, context)) {
      const proposal = await this.createProposal(submission.operatorId, finding);
      if (proposal) created.push(proposal);
    }
    return created;
  }

  /**
   * Opens a slashing proposal for an evidence set. Idempotent on evidence_key,
   * so replaying the same evidence never creates a second proposal or a second slash.
   */
  async createProposal(operatorId: string, finding: SlashableFinding): Promise<ProposalView | null> {
    const evidenceKey = `${finding.reason}:${finding.evidenceIds.join("|")}`;
    const bps = this.policy.slashBps[finding.reason];

    return this.withTransaction(async (client) => {
      // Lock before checking for an existing proposal so concurrent evaluations of
      // the same evidence serialize instead of racing on the unique evidence_key.
      const bond = await this.lockBond(client, operatorId, false);
      if (!bond) return null;

      const existing = await client.query<ProposalRow>(
        `SELECT id, operator_id, reason, evidence_ids, amount, status, appeal_until, execution_tx_hash
         FROM slashing_proposals WHERE evidence_key = $1`,
        [evidenceKey],
      );
      if (existing.rows[0]) return toProposalView(existing.rows[0]);

      const atStake = await this.atStake(client, operatorId, BigInt(bond.bonded_amount));
      const amount = slashAmountFor(atStake, bps);
      if (amount === 0n) return null;

      const autoEligible = this.policy.autoSlash.enabled && bps <= this.policy.autoSlash.maxBps;
      const result = await client.query<ProposalRow>(
        `INSERT INTO slashing_proposals (operator_id, reason, evidence_ids, evidence_key, amount, status, appeal_until)
         VALUES ($1, $2, $3, $4, $5, $6,
           CASE WHEN $6 = 'pending_appeal' THEN now() + make_interval(secs => $7) ELSE NULL END)
         RETURNING id, operator_id, reason, evidence_ids, amount, status, appeal_until, execution_tx_hash`,
        [
          operatorId,
          finding.reason,
          finding.evidenceIds,
          evidenceKey,
          amount.toString(),
          autoEligible ? "pending_appeal" : "pending_review",
          this.policy.autoSlash.appealWindowSeconds,
        ],
      );
      return toProposalView(result.rows[0]);
    });
  }

  /**
   * Approves a proposal. Auto-slash proposals are approvable only after their
   * appeal window closes.
   */
  async approveProposal(proposalId: string, reviewer: string): Promise<ProposalView> {
    const result = await this.db.query<ProposalRow>(
      `UPDATE slashing_proposals SET status = 'approved', reviewed_by = $2, reviewed_at = now(), updated_at = now()
       WHERE id = $1 AND (status = 'pending_review' OR (status = 'pending_appeal' AND appeal_until <= now()))
       RETURNING id, operator_id, reason, evidence_ids, amount, status, appeal_until, execution_tx_hash`,
      [proposalId, reviewer],
    );
    return this.requireTransition(proposalId, result.rows[0]);
  }

  async rejectProposal(proposalId: string, reviewer: string): Promise<ProposalView> {
    const result = await this.db.query<ProposalRow>(
      `UPDATE slashing_proposals SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), updated_at = now()
       WHERE id = $1 AND status IN ('pending_review', 'pending_appeal')
       RETURNING id, operator_id, reason, evidence_ids, amount, status, appeal_until, execution_tx_hash`,
      [proposalId, reviewer],
    );
    return this.requireTransition(proposalId, result.rows[0]);
  }

  /** Moves an auto-slash proposal back to manual review while its appeal window is open. */
  async appealProposal(proposalId: string): Promise<ProposalView> {
    const result = await this.db.query<ProposalRow>(
      `UPDATE slashing_proposals SET status = 'pending_review', appeal_until = NULL, updated_at = now()
       WHERE id = $1 AND status = 'pending_appeal' AND appeal_until > now()
       RETURNING id, operator_id, reason, evidence_ids, amount, status, appeal_until, execution_tx_hash`,
      [proposalId],
    );
    return this.requireTransition(proposalId, result.rows[0]);
  }

  /**
   * Records an approved slash as executed on-chain. The amount is re-capped at
   * the current stake at risk, so a proposal never takes more than is bonded
   * or unbonding. Called after the slasher's contract call is confirmed.
   */
  async executeProposal(proposalId: string, txHash: string): Promise<ProposalView> {
    if (!txHash || txHash.trim() === "") {
      throw new BadRequestException("txHash is required");
    }
    return this.withTransaction(async (client) => {
      const proposalResult = await client.query<ProposalRow>(
        `SELECT id, operator_id, reason, evidence_ids, amount, status, appeal_until, execution_tx_hash
         FROM slashing_proposals WHERE id = $1 FOR UPDATE`,
        [proposalId],
      );
      const proposal = proposalResult.rows[0];
      if (!proposal) throw new NotFoundException("slashing proposal not found");
      if (proposal.status !== "approved") {
        throw new ConflictException("only approved proposals can be executed");
      }

      const bond = await this.lockBond(client, proposal.operator_id);
      const unbondResult = await client.query<UnbondRow>(
        `SELECT id, amount, available_at FROM unbond_requests
         WHERE operator_id = $1 AND status = 'unbonding' ORDER BY requested_at FOR UPDATE`,
        [proposal.operator_id],
      );
      const lots = unbondResult.rows.map((row) => ({ id: row.id, amount: BigInt(row.amount) }));
      const bonded = BigInt(bond.bonded_amount);
      const atStake = lots.reduce((sum, lot) => sum + lot.amount, bonded);
      const slash = min(BigInt(proposal.amount), atStake);

      const { fromBonded, fromUnbonding } = allocateSlash(bonded, lots, slash);
      await client.query(
        "UPDATE operator_bonds SET bonded_amount = bonded_amount - $2, updated_at = now() WHERE operator_id = $1",
        [proposal.operator_id, fromBonded.toString()],
      );
      for (const lot of lots) {
        const take = fromUnbonding.get(lot.id);
        if (take === undefined) continue;
        const remaining = lot.amount - take;
        await client.query(
          "UPDATE unbond_requests SET amount = $2, status = CASE WHEN $2 = 0 THEN 'slashed' ELSE status END WHERE id = $1",
          [lot.id, remaining.toString()],
        );
      }

      const result = await client.query<ProposalRow>(
        `UPDATE slashing_proposals SET status = 'executed', execution_tx_hash = $2, executed_at = now(), updated_at = now()
         WHERE id = $1
         RETURNING id, operator_id, reason, evidence_ids, amount, status, appeal_until, execution_tx_hash`,
        [proposalId, txHash],
      );
      return toProposalView(result.rows[0]);
    });
  }

  private async lockBond(client: PoolClient, operatorId: string): Promise<BondRow>;
  private async lockBond(client: PoolClient, operatorId: string, required: false): Promise<BondRow | undefined>;
  private async lockBond(client: PoolClient, operatorId: string, required = true): Promise<BondRow | undefined> {
    const result = await client.query<BondRow>(
      "SELECT operator_id, bonded_amount, first_bonded_at FROM operator_bonds WHERE operator_id = $1 FOR UPDATE",
      [operatorId],
    );
    if (!result.rows[0] && required) {
      throw new NotFoundException("operator has no bond");
    }
    return result.rows[0];
  }

  private async atStake(client: PoolClient, operatorId: string, bonded: bigint): Promise<bigint> {
    const result = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM unbond_requests
       WHERE operator_id = $1 AND status = 'unbonding'`,
      [operatorId],
    );
    return bonded + BigInt(result.rows[0].total);
  }

  private requireTransition(proposalId: string, row: ProposalRow | undefined): ProposalView {
    if (!row) {
      throw new ConflictException(`slashing proposal ${proposalId} is not in a state that allows this action`);
    }
    return toProposalView(row);
  }

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.db.withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    });
  }
}
