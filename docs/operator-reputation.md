# Operator Reputation Scoring and Consensus Weighting

Model version: `operator-reputation/v1`. Implementation: `src/oracle/reputation.ts`.

Reputation weights each oracle operator's contribution to a corroborated value instead of counting every source equally. A long-running accurate operator outweighs a new or mediocre one, and a new operator has no influence on payout-triggering feeds until it has earned it.

## Inputs

Scoring is a pure function of an operator's history and a clock value `now` supplied by the caller. Nothing reads the system clock, so the same history and `now` always produce the same score.

| Input | Meaning |
|---|---|
| `observations[]` | Each report: `deviationBps` from the corroborated value, `heartbeatMet`, `observedAt`. Reports flagged `excused` (feed-side outage) are ignored. |
| `disputes[]` | Resolved disputes: `outcome` is `upheld` (operator at fault, slashed) or `rejected`. |
| `registeredAt` | Registration time, used for tenure. |

Arithmetic is integer basis points (0–10000). Weights and scores never use floating point, so decisions reproduce across runtimes.

## Components

Each component is in `[0, 10000]`.

| Component | Weight | Definition |
|---|---|---|
| Accuracy | 40% | Decayed mean of `10000 - deviationBps` (clamped at 0). |
| Availability | 25% | Decayed mean of `10000` for heartbeat met, `0` otherwise. |
| Disputes | 25% | Decayed mean of `0` for upheld, `10000` for rejected. Baseline with no history is `10000`. |
| Tenure | 10% | `min(10000, age / 90 days * 10000)`. Not decayed. |

`score = floor(Σ weight_i × component_i / 100)`, so the score is in `[0, 10000]`.

Every component is monotonic: lower deviation, more heartbeats, fewer upheld disputes, or longer tenure never lowers the score.

## Time decay

Each event's influence halves every 7 days (`HALF_LIFE_MS`). Integer weight is `10000 >> floor(age / half-life)`, which reaches 0 after 14 half-lives. Recent behavior therefore dominates.

Decayed means are smoothed toward a prior with weight `10000` (one fresh, fully weighted event):

`component = floor((PRIOR_WEIGHT × prior + Σ w_i × v_i) / (PRIOR_WEIGHT + Σ w_i))`

- The denominator is always at least `10000`, so sparse or cold-start history never divides by zero and never produces NaN.
- Accuracy and availability use prior `0`, so an operator must earn them.
- Disputes use prior `10000`, so an operator is innocent until an upheld dispute.

**Recovery after a mass outage:** heartbeats missed during a feed-side outage are marked `excused` and don't count against availability. Any genuine misses decay to zero weight within 14 half-lives (about 98 days), and fresh heartbeats restore the score as they arrive.

## Probation and eligibility

An operator is **eligible** only if both hold:

- It has at least `MIN_HISTORY_OBSERVATIONS = 30` non-excused observations.
- Its score is at least `ELIGIBILITY_THRESHOLD_BPS = 5000`.

Operators that are not eligible are on probation. They are recorded, but read-only, and excluded from quorum.

## Consensus weight

Eligible operators get a weight linear in their score, mapped onto `[1000, 2000]`:

`weight = 1000 + floor((score − 5000) × 1000 / 5000)`

Ineligible operators get weight `0`.

- **Floor (1000):** every eligible operator contributes something, even at the threshold.
- **Cap (2000):** no operator can hold more than twice a floor-weight operator's weight.
- **Quorum:** `MIN_QUORUM_OPERATORS = 3`. With at least three eligible operators, one operator's share of total weight is at most `2000 / (2000 + 1000 + 1000) = 1/2`. No single operator can decide a weighted-median outcome alone.

`weightOperators` returns a `status`:

| Status | Meaning | Required action |
|---|---|---|
| `ok` | At least 3 eligible operators | Proceed with weighted consensus. |
| `insufficient` | 1–2 eligible operators | Alert. Do not finalize a payout-triggering decision on this quorum. |
| `no_eligible_operators` | Zero eligible operators | Alert loudly. A feed with no eligible operators must never fail silently. |

## Auditability

Each decision stamps the `weight` and `components` of every operator it used, along with `asOf` and `REPUTATION_MODEL_VERSION`. A past decision can therefore be explained from its snapshot without recomputing from current history.

## Parameters

| Constant | Value | Effect |
|---|---|---|
| `HALF_LIFE_MS` | 7 days | Decay rate of event influence |
| `TENURE_FULL_MS` | 90 days | Time to full tenure credit |
| `MIN_HISTORY_OBSERVATIONS` | 30 | Probation until this much history |
| `ELIGIBILITY_THRESHOLD_BPS` | 5000 | Minimum score for quorum |
| `MIN_CONSENSUS_WEIGHT_BPS` | 1000 | Weight floor |
| `MAX_CONSENSUS_WEIGHT_BPS` | 2000 | Weight cap |
| `MIN_QUORUM_OPERATORS` | 3 | Minimum eligible operators for `ok` |

## Out of scope

- Staking or slashing mechanics (external contract).
- Persistence of snapshots, the scheduled recomputation job, and the consensus layer that consumes weights. These depend on operator registry, observation, and dispute data that does not yet exist in this repository.
