# Oracle Operator Staking and Slashing Policy

**Status:** Draft for review
**Implements:** Refract-Protocol/refract-backend#192
**Code:** `src/services/staking.ts`, `src/routes/staking.ts`, `src/db/schema.sql`

Operators bond stake to serve payout-triggering feeds. They lose part of it
when their submissions are proven faulty, and must wait out an unbonding period
before withdrawing. This document is the published policy. Values marked
"configurable" are set by environment variables and take effect at process start.

## 1. Custody and roles

- Funds never sit with the backend. Bonds, unbond requests, and slashes are
  settled by the staking contract. The backend mirrors confirmed contract events
  into `operator_bonds`, `unbond_requests`, and `slashing_proposals`.
- **Slasher:** the only address allowed to call the contract's slash entry point.
  It must be a multisig or threshold account, so a single compromised key cannot
  drain bonds. The backend may be one signer; an operator-multisig path is the
  other.
- **Reviewer:** an ops operator who approves or rejects slashing proposals.

## 2. Bonding and eligibility

- An operator bonds stake in base units. Top-ups add to the existing bond.
- **Minimum bond per feed tier (configurable):**

  | Tier | Env var | Default (base units, 7 decimals) |
  |---|---|---|
  | `tier1` | `STAKING_MIN_BOND_TIER1` | 50,000 units |
  | `tier2` | `STAKING_MIN_BOND_TIER2` | 25,000 units |
  | `tier3` | `STAKING_MIN_BOND_TIER3` | 10,000 units |

- **Bond age:** `STAKING_MIN_BOND_AGE_SECONDS` (default 7 days). Age is anchored
  to the first bond, so top-ups do not reset it. This stops flash-bond-then-slash
  dodging: a stake placed just before a feed round cannot serve that feed.
- An operator who is below the minimum or too new for a tier is excluded from
  that tier's quorum. Eligibility is reported as `eligibleTiers` by
  `GET /api/v1/staking/operators/:operatorId`.
- Unbonding reduces the bond immediately, so an operator drops out of tiers
  they no longer meet as soon as they request unbonding.

## 3. Unbonding and withdrawal

- `POST /api/v1/staking/operators/:operatorId/unbond` moves stake into an
  unbonding lot. Default period: `STAKING_UNBONDING_PERIOD_SECONDS`, 14 days.
- Unbonding stake stays slashable until withdrawn.
- `POST /api/v1/staking/operators/:operatorId/withdraw` releases lots whose
  period has elapsed. It is **refused while any slashing proposal for the
  operator is open** (`pending_review`, `pending_appeal`, or `approved`), so
  unbonding cannot be used to escape an in-flight proposal.
- Status responses show each lot's `availableAt` and `remainingSeconds`, plus
  open proposals in `pendingSlashing`.

## 4. Slashable conditions

The backend evaluates each oracle submission against the corroborated consensus
for its round and the operator's quarantine record. It produces one proposal per
condition found, with the evidence ids attached.

| Reason | Condition | Default slash (configurable) |
|---|---|---|
| `outside_tolerance` | Submitted value differs from the corroborated consensus by more than the round's tolerance (basis points). | 5% (`STAKING_SLASH_BPS_OUTSIDE_TOLERANCE=500`) |
| `post_quarantine` | Submission made after the operator was quarantined. | 10% (`STAKING_SLASH_BPS_POST_QUARANTINE=1000`) |
| `equivocation` | Two different values from one operator for the same feed and round. Both evidence ids are attached. | 25% (`STAKING_SLASH_BPS_EQUIVOCATION=2500`) |

**Amount rule.** The slash is `floor(stakeAtRisk × bps / 10,000)`, capped at
stake at risk. Rounding always goes down, so it never over-slashes.
`stakeAtRisk` is bonded stake plus unbonding lots. At execution the amount is
re-capped at the current stake at risk.

**Idempotency.** Each proposal has a unique `evidence_key`, built from the reason
and the sorted evidence ids. Re-evaluating the same evidence returns the existing
proposal and never creates a second one.

## 5. Review and approval

Default: **every proposal requires manual review.** Nothing moves without an
approval from a reviewer.

- `approve` → `approved`. Only `pending_review` proposals can be approved, plus
  auto-slash proposals whose appeal window has closed.
- `reject` → `rejected`.
- `execute` (with the confirmed transaction hash) → `executed`. The
  backend records the execution after the slasher's contract call is confirmed.
  It does not submit the slash itself.

**Bounded auto-slash (opt-in, `STAKING_AUTO_SLASH_ENABLED=true`).** Only reasons
whose slash rate is at or below `STAKING_AUTO_SLASH_MAX_BPS` (default 5%) are
auto-proposed. They are created as `pending_appeal` with an appeal window
(`STAKING_APPEAL_WINDOW_SECONDS`, default 3 days). During the window the operator
can appeal, which moves the proposal to `pending_review`. Once the window closes
it can be approved. Equivocation is never auto-slashed.

## 6. Unbonding never shields an in-flight slash

When a slash executes, it is taken from bonded stake first, then from unbonding
lots in request order. Lots that are still unbonding are slashed too. A
proposal opened before withdrawal therefore cannot be defeated by unbonding.

## 7. Operator-facing API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/staking/operators/:operatorId` | Bond, eligible tiers, unbonding lots with remaining time, open slashing proposals |
| POST | `/api/v1/staking/operators/:operatorId/bonds` | Record a confirmed bond |
| POST | `/api/v1/staking/operators/:operatorId/unbond` | Record an unbond request |
| POST | `/api/v1/staking/operators/:operatorId/withdraw` | Release matured lots when no proposal is open |
| POST | `/api/v1/staking/slashing/evaluate` | Evaluate a submission and open proposals for any slashable conditions |
| POST | `/api/v1/staking/slashing/proposals/:id/approve` | Approve (reviewer) |
| POST | `/api/v1/staking/slashing/proposals/:id/reject` | Reject (reviewer) |
| POST | `/api/v1/staking/slashing/proposals/:id/appeal` | Appeal an auto-slash proposal |
| POST | `/api/v1/staking/slashing/proposals/:id/execute` | Record an executed slash |

All endpoints are ops-authenticated (`OPS_API_TOKEN`) until operator-scoped
authentication exists.

## 8. Out of scope

- Reputation scoring beyond bond weight.
- Treasury and insurance-fund economics.
- Cross-chain stake.
- The Soroban staking contract. It lives outside this repository and is the
  authority for balances; this backend only mirrors its confirmed events.
