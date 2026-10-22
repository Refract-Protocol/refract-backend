Looking at this task, I need to create `src/services/claimProcessor.ts` with a refactored, pure trigger-evaluation function. Since the file is being created (not modified), I'll build a complete, well-structured module that:

1. Extracts policy trigger evaluation into a pure function parameterized by feed state
2. Provides a preview function that performs zero writes
3. Keeps the existing claim processing behavior intact
4. Includes tests

Let me write the complete file content.

```typescript
/**
 * Claim processing service.
 *
 * This module owns policy evaluation and claim settlement. As of issue #299,
 * the trigger-evaluation logic has been extracted into a pure, side-effect-free
 * function (`evaluatePolicyTriggers`) that is parameterized by feed state. This
 * allows the manual-oracle-override preview path to run the *real* evaluation
 * logic against a proposed feed state without writing anything, rather than
 * maintaining a parallel approximation that could drift from production
 * behavior.
 *
 * Invariants:
 *  - `evaluatePolicyTriggers` performs no I/O and mutates nothing. It is safe
 *    to call from the preview path.
 *  - `previewOverrideImpact` performs zero writes. It reads a consistent
 *    snapshot and returns a description of what *would* happen.
 *  - Only `processClaims` / `applyOverrideAndSettle` may write decisions or
 *    move money.
 */

import type { Pool, PoolClient } from 'pg';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single feed's state as observed at evaluation time. */
export interface FeedState {
  feedId: string;
  /** The numeric value the feed currently reports (null when suppressed). */
  value: number | null;
  /** Whether the feed is currently suppressed (no value available). */
  suppressed: boolean;
}

/**
 * A proposed override for a feed. `value` and `suppressed` are mutually
 * exclusive: a suppression override sets `suppressed: true` and `value: null`.
 */
export interface ProposedOverride {
  feedId: string;
  value: number | null;
  suppressed: boolean;
  /** ISO timestamp; the override is only in effect within this window. */
  effectiveFrom: string;
  effectiveUntil: string;
}

/** The subset of a policy row needed to evaluate triggers. */
export interface PolicyForEvaluation {
  id: string;
  /** The feed this policy keys off of. */
  feedId: string;
  /** Comparison operator applied to the feed value. */
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
  /** Threshold the feed value is compared against. */
  threshold: number;
  /** Payout amount (in minor units) if the policy triggers. */
  payoutAmount: number;
  /** Whether the policy is currently active. */
  active: boolean;
  /** Last-modified timestamp, used to detect mutation between preview/apply. */
  updatedAt: string;
}

/** Result of evaluating a single policy against a feed state. */
export interface PolicyTriggerResult {
  policyId: string;
  /** Whether the policy triggers under the supplied feed state. */
  triggered: boolean;
  /** The feed value that was used (null when suppressed). */
  observedValue: number | null;
  /** Whether the feed was suppressed at evaluation time. */
  suppressed: boolean;
}

/** Aggregate result of evaluating a set of policies. */
export interface TriggerEvaluation {
  results: PolicyTriggerResult[];
  /** Policies that triggered, in input order. */
  triggeredPolicyIds: string[];
  /** Sum of payoutAmount across triggered policies. */
  totalExposure: number;
  /** True when the policy scan was bounded and results were truncated. */
  truncated: boolean;
}

/** Per-policy entry in an override preview. */
export interface PreviewPolicyEntry {
  policyId: string;
  /** Whether the policy triggers under the *current* feed state. */
  triggersUnderCurrent: boolean;
  /** Whether the policy triggers under the *proposed* feed state. */
  triggersUnderProposed: boolean;
  /** True when the proposed state changes the trigger outcome. */
  changed: boolean;
  payoutAmount: number;
}

/** The full dry-run preview returned to the operator. */
export interface OverridePreview {
  feedId: string;
  proposed: ProposedOverride;
  /** Hash of the inputs used to generate this preview. */
  inputHash: string;
  /** Policies whose trigger outcome differs between current and proposed. */
  affectedPolicies: PreviewPolicyEntry[];
  /** Total payout exposure under the current feed state. */
  currentExposure: number;
  /** Total payout exposure under the proposed feed state. */
  proposedExposure: number;
  /** Net change in exposure (proposed - current). */
  exposureDelta: number;
  /** True when the policy scan was bounded and results were truncated. */
  truncated: boolean;
  /** Number of policies scanned. */
  scannedCount: number;
  /** ISO timestamp the preview was generated. */
  generatedAt: string;
}

/** Options controlling the bounded policy scan. */
export interface PreviewOptions {
  /** Maximum number of policies to scan. Defaults to 5000. */
  maxPolicies?: number;
}

// ---------------------------------------------------------------------------
// Pure trigger evaluation
// ---------------------------------------------------------------------------

const DEFAULT_MAX_POLICIES = 5000;

/**
 * Compare a feed value against a policy threshold using the policy operator.
 * Pure; no I/O.
 */
function compare(
  value: number,
  operator: PolicyForEvaluation['operator'],
  threshold: number,
): boolean {
  switch (operator) {
    case 'gt':
      return value > threshold;
    case 'gte':
      return value >= threshold;
    case 'lt':
      return value < threshold;
    case 'lte':
      return value <= threshold;
    case 'eq':
      return value === threshold;
    case 'neq':
      return value !== threshold;
    default: {
      // Exhaustiveness guard.
      const _never: never = operator;
      throw new Error(`Unknown operator: ${String(_never)}`);
    }
  }
}

/**
 * Evaluate a single policy against a feed state. Pure; no I/O.
 *
 * A suppressed feed never triggers a policy (there is no value to compare).
 */
export function evaluatePolicy(
  policy: PolicyForEvaluation,
  feed: FeedState,
): PolicyTriggerResult {
  if (!policy.active) {
    return {
      policyId: policy.id,
      triggered: false,
      observedValue: feed.value,
      suppressed: feed.suppressed,
    };
  }

  if (feed.suppressed || feed.value === null) {
    return {
      policyId: policy.id,
      triggered: false,
      observedValue: null,
      suppressed: true,
    };
  }

  const triggered = compare(feed.value, policy.operator, policy.threshold);
  return {
    policyId: policy.id,
    triggered,
    observedValue: feed.value,
    suppressed: false,
  };
}

/**
 * Evaluate a set of policies against a feed state. Pure; no I/O.
 *
 * This is the single source of truth for trigger evaluation. Both the live
 * claim processor and the override preview call this function so that the
 * preview reflects exactly what would happen if the override were applied.
 *
 * The scan is bounded by `maxPolicies`; when the input exceeds the bound the
 * result is marked `truncated` so callers can surface that to the operator.
 */
export function evaluatePolicyTriggers(
  policies: readonly PolicyForEvaluation[],
  feed: FeedState,
  options: PreviewOptions = {},
): TriggerEvaluation {
  const maxPolicies = options.maxPolicies ?? DEFAULT_MAX_POLICIES;
  const bounded = policies.slice(0, maxPolicies);
  const truncated = policies.length > maxPolicies;

  const results: PolicyTriggerResult[] = [];
  const triggeredPolicyIds: string[] = [];
  let totalExposure = 0;

  for (const policy of bounded) {
    const result = evaluatePolicy(policy, feed);
    results.push(result);
    if (result.triggered) {
      triggeredPolicyIds.push(policy.id);
      totalExposure += policy.payoutAmount;
    }
  }

  return { results, triggeredPolicyIds, totalExposure, truncated };
}

// ---------------------------------------------------------------------------
// Feed-state helpers
// ---------------------------------------------------------------------------

/**
 * Build the feed state that would result from applying a proposed override.
 * Pure; no I/O.
 */
export function feedStateFromOverride(override: ProposedOverride): FeedState {
  return {
    feedId: override.feedId,
    value: override.suppressed ? null : override.value,
    suppressed: override.suppressed,
  };
}

/**
 * Build the feed state representing the current (pre-override) state.
 * Pure; no I/O.
 */
export function currentFeedState(feed: FeedState): FeedState {
  return { feedId: feed.feedId, value: feed.value, suppressed: feed.suppressed };
}

// ---------------------------------------------------------------------------
// Input hashing
// ---------------------------------------------------------------------------

/**
 * Compute a stable hash of the inputs that produced a preview. Used to detect
 * mismatches between a reviewed preview and the override that is applied.
 *
 * This is a lightweight, dependency-free FNV-1a hash. It is not a
 * cryptographic hash; it exists to detect accidental drift, not to resist
 * tampering. The preview id (a server-generated UUID) is the authoritative
 * linkage; the hash is a secondary integrity check.
 */
export function hashPreviewInputs(
  feedId: string,
  proposed: ProposedOverride,
  policies: readonly PolicyForEvaluation[],
): string {
  const canonical = JSON.stringify({
    feedId,
    proposed: {
      feedId: proposed.feedId,
      value: proposed.value,
      suppressed: proposed.suppressed,
      effectiveFrom: proposed.effectiveFrom,
      effectiveUntil: proposed.effectiveUntil,
    },
    policies: policies
      .map((p) => ({
        id: p.id,
        feedId: p.feedId,
        operator: p.operator,
        threshold: p.threshold,
        payoutAmount: p.payoutAmount,
        active: p.active,
        updatedAt: p.updatedAt,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  });

  // FNV-1a 32-bit.
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Preview (zero writes)
// ---------------------------------------------------------------------------

/**
 * Generate a dry-run preview of the impact of a proposed override.
 *
 * This function performs **zero writes**: it opens a read-only transaction,
 * reads a consistent snapshot of the relevant policies, evaluates triggers
 * against both the current and proposed feed states using the shared pure
 * evaluator, and returns the result. It does not settle claims, does not
 * write decisions, and does not alter feed state.
 *
 * The caller (the admin route) is responsible for persisting the preview
 * record and its input hash; this function is deliberately free of side
 * effects so it can be unit-tested for that property.
 */
export async function previewOverrideImpact(
  db: Pool,
  currentFeed: FeedState,
  proposed: ProposedOverride,
  options: PreviewOptions = {},
): Promise<OverridePreview> {
  if (proposed.feedId !== currentFeed.feedId) {
    throw new Error(
      `Override feedId ${proposed.feedId} does not match current feed ${currentFeed.feedId}`,
    );
  }
  if (proposed.suppressed && proposed.value !== null) {
    throw new Error('A suppression override must not carry a value');
  }
  if (!proposed.suppressed && proposed.value === null) {
    throw new Error('A non-suppression override must carry a value');
  }

  const maxPolicies = options.maxPolicies ?? DEFAULT_MAX_POLICIES;

  // Single read transaction for a consistent snapshot. We use a read-only
  // transaction so that any accidental write attempt fails loudly.
  const client: PoolClient = await db.connect();
  let policies: PolicyForEvaluation[];
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const { rows } = await client.query<{
      id: string;
      feed_id: string;
      operator: PolicyForEvaluation['operator'];
      threshold: string;
      payout_amount: string;
      active: boolean;
      updated_at: string;
    }>(
      `SELECT id, feed_id, operator, threshold, payout_amount, active, updated_at
         FROM policies
        WHERE feed_id = $1
          AND active = TRUE
        ORDER BY id
        LIMIT $2`,
      [currentFeed.feedId, maxPolicies + 1],
    );
    policies = rows.map((r) => ({
      id: r.id,
      feedId: r.feed_id,
      operator: r.operator,
      threshold: Number(r.threshold),
      payoutAmount: Number(r.payout_amount),
      active: r.active,
      updatedAt: r.updated_at,
    }));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  const truncated = policies.length > maxPolicies;
  const boundedPolicies = truncated ? policies.slice(0, maxPolicies) : policies;

  const currentEval = evaluatePolicyTriggers(
    boundedPolicies,
    currentFeedState(currentFeed),
    { maxPolicies },
  );
  const proposedEval = evaluatePolicyTriggers(
    boundedPolicies,
    feedStateFromOverride(proposed),
    { maxPolicies },
  );

  const currentById = new Map(
    currentEval.results.map((r) => [r.policyId, r.triggered]),
  );

  const affectedPolicies: PreviewPolicyEntry[] = [];
  for (const result of proposedEval.results) {
    const triggersUnderCurrent = currentById.get(result.policyId) ?? false;
    const triggersUnderProposed = result.triggered;
    if (triggersUnderCurrent !== triggersUnderProposed) {
      const policy = boundedPolicies.find((p) => p.id === result.policyId);
      affectedPolicies.push({
        policyId: result.policyId,
        triggersUnderCurrent,
        triggersUnderProposed,
        changed: true,
        payoutAmount: policy?.payoutAmount ?? 0,
      });
    }
  }

  const inputHash = hashPreviewInputs(
    currentFeed.feedId,
    proposed,
    boundedPolicies,
  );

  return {
    feedId: currentFeed.feedId,
    proposed,
    inputHash,
    affectedPolicies,
    currentExposure: currentEval.totalExposure,
    proposedExposure: proposedEval.totalExposure,
    exposureDelta: proposedEval.totalExposure - currentEval.totalExposure,
    truncated,
    scannedCount: boundedPolicies.length,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Live claim processing (writes)
// ---------------------------------------------------------------------------

/** A claim decision to be persisted. */
export interface ClaimDecision {
  policyId: string;
  feedId: string;
  triggered: boolean;
  observedValue: number | null;
  payoutAmount: number;
}

/**
 * Process claims for a feed: evaluate all active policies against the current
 * feed state and persist decisions for any that trigger.
 *
 * This is the only path in this module that writes decisions or moves money.
 * It reuses `evaluatePolicyTriggers` so that live settlement and preview share
 * identical evaluation semantics.
 *
 * Returns the decisions that were written.
 */
export async function processClaims(
  db: Pool,
  feed: FeedState,
  options: PreviewOptions = {},
): Promise<ClaimDecision[]> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{
      id: string;
      feed_id: string;
      operator: PolicyForEvaluation['operator'];
      threshold: string;
      payout_amount: string;
      active: boolean;
      updated_at: string;
    }>(
      `SELECT id, feed_id, operator, threshold, payout_amount, active, updated_at
         FROM policies
        WHERE feed_id = $1
          AND active = TRUE
        ORDER BY id`,
      [feed.feedId],
    );

    const policies: PolicyForEvaluation[] = rows.map((r) => ({
      id: r.id,
      feedId: r.feed_id,
      operator: r.operator,
      threshold: Number(r.threshold),
      payoutAmount: Number(r.payout_amount),
      active: r.active,
      updatedAt: r.updated_at,
    }));

    const evaluation = evaluatePolicyTriggers(policies, feed, options);
    const decisions: ClaimDecision[] = [];

    for (const result of evaluation.results) {
      if (!result.triggered) continue;
      const policy = policies.find((p) => p.id === result.policyId);
      if (!policy) continue;
      await client.query(
        `INSERT INTO claim_decisions
           (policy_id, feed_id, observed_value, payout_amount, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [policy.id, feed.feedId, result.observedValue, policy.payoutAmount],
      );
      decisions.push({
        policyId: policy.id,
        feedId: feed.feedId,
        triggered: true,
        observedValue: result.observedValue,
        payoutAmount: policy.payoutAmount,
      });
    }

    await client.query('COMMIT');
    return decisions;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
```

Now the test file. Since the step asks for tests asserting the preview performs zero writes and that the preview-triggered set matches the actual post-apply triggered set, I'll include a test file as well. However, the task says "Return the COMPLETE new file content" for a single file. The step mentions adding tests. I'll include the tests in a companion file since they cannot live in the same module cleanly. But the instruction says return only the file content for the given file.

Given the ambiguity, I'll return the main file content as requested. The tests would be in a separate file (`src/services/claimProcessor.test.ts`), which is a different file from the one specified. The instruction is to return the complete new file content for `src/services/claimProcessor.ts`. I'll return just that file.

```typescript
/**
 * Claim processing service.
 *
 * This module owns policy evaluation and claim settlement. As of issue #299,
 * the trigger-evaluation logic has been extracted into a pure, side-effect-free
 * function (`evaluatePolicyTriggers`) that is parameterized by feed state. This
 * allows the manual-oracle-override preview path to run the *real* evaluation
 * logic against a proposed feed state without writing anything, rather than
 * maintaining a parallel approximation that could drift from production
 * behavior.
 *
 * Invariants:
 *  - `evaluatePolicyTriggers` performs no I/O and mutates nothing. It is safe
 *    to call from the preview path.
 *  - `previewOverrideImpact` performs zero writes. It reads a consistent
 *    snapshot and returns a description of what *would* happen.
 *  - Only `processClaims` may write decisions or move money.
 */

import type { Pool, PoolClient } from 'pg';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single feed's state as observed at evaluation time. */
export interface FeedState {
  feedId: string;
  /** The numeric value the feed currently reports (null when suppressed). */
  value: number | null;
  /** Whether the feed is currently suppressed (no value available). */
  suppressed: boolean;
}

/**
 * A proposed override for a feed. `value` and `suppressed` are mutually
 * exclusive: a suppression override sets `suppressed: true` and `value: null`.
 */
export interface ProposedOverride {
  feedId: string;
  value: number | null;
  suppressed: boolean;
  /** ISO timestamp; the override is only in effect within this window. */
  effectiveFrom: string;
  effectiveUntil: string;
}

/** The subset of a policy row needed to evaluate triggers. */
export interface PolicyForEvaluation {
  id: string;
  /** The feed this policy keys off of. */
  feedId: string;
  /** Comparison operator applied to the feed value. */
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';
  /** Threshold the feed value is compared against. */
  threshold: number;
  /** Payout amount (in minor units) if the policy triggers. */
  payoutAmount: number;
  /** Whether the policy is currently active. */
  active: boolean;
  /** Last-modified timestamp, used to detect mutation between preview/apply. */
  updatedAt: string;
}

/** Result of evaluating a single policy against a feed state. */
export interface PolicyTriggerResult {
  policyId: string;
  /** Whether the policy triggers under the supplied feed state. */
  triggered: boolean;
  /** The feed value that was used (null when suppressed). */
  observedValue: number | null;
  /** Whether the feed was suppressed at evaluation time. */
  suppressed: boolean;
}

/** Aggregate result of evaluating a set of policies. */
export interface TriggerEvaluation {
  results: PolicyTriggerResult[];
  /** Policies that triggered, in input order. */
  triggeredPolicyIds: string[];
  /** Sum of payoutAmount across triggered policies. */
  totalExposure: number;
  /** True when the policy scan was bounded and results were truncated. */
  truncated: boolean;
}

/** Per-policy entry in an override preview. */
export interface PreviewPolicyEntry {
  policyId: string;
  /** Whether the policy triggers under the *current* feed state. */
  triggersUnderCurrent: boolean;
  /** Whether the policy triggers under the *proposed* feed state. */
  triggersUnderProposed: boolean;
  /** True when the proposed state changes the trigger outcome. */
  changed: boolean;
  payoutAmount: number;
}

/** The full dry-run preview returned to the operator. */
export interface OverridePreview {
  feedId: string;
  proposed: ProposedOverride;
  /** Hash of the inputs used to generate this preview. */
  inputHash: string;
  /** Policies whose trigger outcome differs between current and proposed. */
  affectedPolicies: PreviewPolicyEntry[];
  /** Total payout exposure under the current feed state. */
  currentExposure: number;
  /** Total payout exposure under the proposed feed state. */
  proposedExposure: number;
  /** Net change in exposure (proposed - current). */
  exposureDelta: number;
  /** True when the policy scan was bounded and results were truncated. */
  truncated: boolean;
  /** Number of policies scanned. */
  scannedCount: number;
  /** ISO timestamp the preview was generated. */
  generatedAt: string;
}

/** Options controlling the bounded policy scan. */
export interface PreviewOptions {
  /** Maximum number of policies to scan. Defaults to 5000. */
  maxPolicies?: number;
}

// ---------------------------------------------------------------------------
// Pure trigger evaluation
// ---------------------------------------------------------------------------

const DEFAULT_MAX_POLICIES = 5000;

/**
 * Compare a feed value against a policy threshold using the policy operator.
 * Pure; no I/O.
 */
function compare(
  value: number,
  operator: PolicyForEvaluation['operator'],
  threshold: number,
): boolean {
  switch (operator) {
    case 'gt':
      return value > threshold;
    case 'gte':
      return value >= threshold;
    case 'lt':
      return value < threshold;
    case 'lte':
      return value <= threshold;
    case 'eq':
      return value === threshold;
    case 'neq':
      return value !== threshold;
    default: {
      // Exhaustiveness guard.
      const _never: never = operator;
      throw new Error(`Unknown operator: ${String(_never)}`);
    }
  }
}

/**
 * Evaluate a single policy against a feed state. Pure; no I/O.
 *
 * A suppressed feed never triggers a policy (there is no value to compare).
 */
export function evaluatePolicy(
  policy: PolicyForEvaluation,
  feed: FeedState,
): PolicyTriggerResult {
  if (!policy.active) {
    return {
      policyId: policy.id,
      triggered: false,
      observedValue: feed.value,
      suppressed: feed.suppressed,
    };
  }

  if (feed.suppressed || feed.value === null) {
    return {
      policyId: policy.id,
      triggered: false,
      observedValue: null,
      suppressed: true,
    };
  }

  const triggered = compare(feed.value, policy.operator, policy.threshold);
  return {
    policyId: policy.id,
    triggered,
    observedValue: feed.value,
    suppressed: false,
  };
}

/**
 * Evaluate a set of policies against a feed state. Pure; no I/O.
 *
 * This is the single source of truth for trigger evaluation. Both the live
 * claim processor and the override preview call this function so that the
 * preview reflects exactly what would happen if the override were applied.
 *
 * The scan is bounded by `maxPolicies`; when the input exceeds the bound the
 * result is marked `truncated` so callers can surface that to the operator.
 */
export function evaluatePolicyTriggers(
  policies: readonly PolicyForEvaluation[],
  feed: FeedState,
  options: PreviewOptions = {},
): TriggerEvaluation {
  const maxPolicies = options.maxPolicies ?? DEFAULT_MAX_POLICIES;
  const bounded = policies.slice(0, maxPolicies);
  const truncated = policies.length > maxPolicies;

  const results: PolicyTriggerResult[] = [];
  const triggeredPolicyIds: string[] = [];
  let totalExposure = 0;

  for (const policy of bounded) {
    const result = evaluatePolicy(policy, feed);
    results.push(result);
    if (result.triggered) {
      triggeredPolicyIds.push(policy.id);
      totalExposure += policy.payoutAmount;
    }
  }

  return { results, triggeredPolicyIds, totalExposure, truncated };
}

// ---------------------------------------------------------------------------
// Feed-state helpers
// ---------------------------------------------------------------------------

/**
 * Build the feed state that would result from applying a proposed override.
 * Pure; no I/O.
 */
export function feedStateFromOverride(override: ProposedOverride): FeedState {
  return {
    feedId: override.feedId,
    value: override.suppressed ? null : override.value,
    suppressed: override.suppressed,
  };
}

/**
 * Build the feed state representing the current (pre-override) state.
 * Pure; no I/O.
 */
export function currentFeedState(feed: FeedState): FeedState {
  return { feedId: feed.feedId, value: feed.value, suppressed: feed.suppressed };
}

// ---------------------------------------------------------------------------
// Input hashing
// ---------------------------------------------------------------------------

/**
 * Compute a stable hash of the inputs that produced a preview. Used to detect
 * mismatches between a reviewed preview and the override that is applied.
 *
 * This is a lightweight, dependency-free FNV-1a hash. It is not a
 * cryptographic hash; it exists to detect accidental drift, not to resist
 * tampering. The preview id (a server-generated UUID) is the authoritative
 * linkage; the hash is a secondary integrity check.
 */
export function hashPreviewInputs(
  feedId: string,
  proposed: ProposedOverride,
  policies: readonly PolicyForEvaluation[],
): string {
  const canonical = JSON.stringify({
    feedId,
    proposed: {
      feedId: proposed.feedId,
      value: proposed.value,
      suppressed: proposed.suppressed,
      effectiveFrom: proposed.effectiveFrom,
      effectiveUntil: proposed.effectiveUntil,
    },
    policies: policies
      .map((p) => ({
        id: p.id,
        feedId: p.feedId,
        operator: p.operator,
        threshold: p.threshold,
        payoutAmount: p.payoutAmount,
        active: p.active,
        updatedAt: p.updatedAt,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  });

  // FNV-1a 32-bit.
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Preview (zero writes)
// ---------------------------------------------------------------------------

/**
 * Generate a dry-run preview of the impact of a proposed override.
 *
 * This function performs **zero writes**: it opens a read-only transaction,
 * reads a consistent snapshot of the relevant policies, evaluates triggers
 * against both the current and proposed feed states using the shared pure
 * evaluator, and returns the result. It does not settle claims, does not
 * write decisions, and does not alter feed state.
 *
 * The caller (the admin route) is responsible for persisting the preview
 * record and its input hash; this function is deliberately free of side
 * effects so it can be unit-tested for that property.
 */
export async function previewOverrideImpact(
  db: Pool,
  currentFeed: FeedState,
  proposed: ProposedOverride,
  options: PreviewOptions = {},
): Promise<OverridePreview> {
  if (proposed.feedId !== currentFeed.feedId) {
    throw new Error(
      `Override feedId ${proposed.feedId} does not match current feed ${currentFeed.feedId}`,
    );
  }
  if (proposed.suppressed && proposed.value !== null) {
    throw new Error('A suppression override must not carry a value');
  }
  if (!proposed.suppressed && proposed.value === null) {
    throw new Error('A non-suppression override must carry a value');
  }

  const maxPolicies = options.maxPolicies ?? DEFAULT_MAX_POLICIES;

  // Single read transaction for a consistent snapshot. We use a read-only
  // transaction so that any accidental write attempt fails loudly.
  const client: PoolClient = await db.connect();
  let policies: PolicyForEvaluation[];
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const { rows } = await client.query<{
      id: string;
      feed_id: string;
      operator: PolicyForEvaluation['operator'];
      threshold: string;
      payout_amount: string;
      active: boolean;
      updated_at: string;
    }>(
      `SELECT id, feed_id, operator, threshold, payout_amount, active, updated_at
         FROM policies
        WHERE feed_id = $1
          AND active = TRUE
        ORDER BY id
        LIMIT $2`,
      [currentFeed.feedId, maxPolicies + 1],
    );
    policies = rows.map((r) => ({
      id: r.id,
      feedId: r.feed_id,
      operator: r.operator,
      threshold: Number(r.threshold),
      payoutAmount: Number(r.payout_amount),
      active: r.active,
      updatedAt: r.updated_at,
    }));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  const truncated = policies.length > maxPolicies;
  const boundedPolicies = truncated ? policies.slice(0, maxPolicies) : policies;

  const currentEval = evaluatePolicyTriggers(
    boundedPolicies,
    currentFeedState(currentFeed),
    { maxPolicies },
  );
  const proposedEval = evaluatePolicyTriggers(
    boundedPolicies,
    feedStateFromOverride(proposed),
    { maxPolicies },
  );

  const currentById = new Map(
    currentEval.results.map((r) => [r.policyId, r.triggered]),
  );

  const affectedPolicies: PreviewPolicyEntry[] = [];
  for (const result of proposedEval.results) {
    const triggersUnderCurrent = currentById.get(result.policyId) ?? false;
    const triggersUnderProposed = result.triggered;
    if (triggersUnderCurrent !== triggersUnderProposed) {
      const policy = boundedPolicies.find((p) => p.id === result.policyId);
      affectedPolicies.push({
        policyId: result.policyId,
        triggersUnderCurrent,
        triggersUnderProposed,
        changed: true,
        payoutAmount: policy?.payoutAmount ?? 0,
      });
    }
  }

  const inputHash = hashPreviewInputs(
    currentFeed.feedId,
    proposed,
    boundedPolicies,
  );

  return {
    feedId: currentFeed.feedId,
    proposed,
    inputHash,
    affectedPolicies,
    currentExposure: currentEval.totalExposure,
    proposedExposure: proposedEval.totalExposure,
    exposureDelta: proposedEval.totalExposure - currentEval.totalExposure,
    truncated,
    scannedCount: boundedPolicies.length,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Live claim processing (writes)
// ---------------------------------------------------------------------------

/** A claim decision to be persisted. */
export interface ClaimDecision {
  policyId: string;
  feedId: string;
  triggered: boolean;
  observedValue: number | null;
  payoutAmount: number;
}

/**
 * Process claims for a feed: evaluate all active policies against the current
 * feed state and persist decisions for any that trigger.
 *
 * This is the only path in this module that writes decisions or moves money.
 * It reuses `evaluatePolicyTriggers` so that live settlement and preview share
 * identical evaluation semantics.
 *
 * Returns the decisions that were written.
 */
export async function processClaims(
  db: Pool,
  feed: FeedState,
  options: PreviewOptions = {},
): Promise<ClaimDecision[]> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{
      id: string;
      feed_id: string;
      operator: PolicyForEvaluation['operator'];
      threshold: string;
      payout_amount: string;
      active: boolean;
      updated_at: string;
    }>(
      `SELECT id, feed_id, operator, threshold, payout_amount, active, updated_at
         FROM policies
        WHERE feed_id = $1
          AND active = TRUE
        ORDER BY id`,
      [feed.feedId],
    );

    const policies: PolicyForEvaluation[] = rows.map((r) => ({
      id: r.id,
      feedId: r.feed_id,
      operator: r.operator,
      threshold: Number(r.threshold),
      payoutAmount: Number(r.payout_amount),
      active: r.active,
      updatedAt: r.updated_at,
    }));

    const evaluation = evaluatePolicyTriggers(policies, feed, options);
    const decisions: ClaimDecision[] = [];

    for (const result of evaluation.results) {
      if (!result.triggered) continue;
      const policy = policies.find((p) => p.id === result.policyId);
      if (!policy) continue;
      await client.query(
        `INSERT INTO claim_decisions
           (policy_id, feed_id, observed_value, payout_amount, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [policy.id, feed.feedId, result.observedValue, policy.payoutAmount],
      );
      decisions.push({
        policyId: policy.id,
        feedId: feed.feedId,
        triggered: true,
        observedValue: result.observedValue,
        payoutAmount: policy.payoutAmount,
      });
    }

    await client.query('COMMIT');
    return decisions;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}