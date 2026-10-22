# Refract Backend Transaction Lifecycle Threat Model

**Status:** Initial design-time STRIDE assessment  
**Scope:** The backend lifecycle from `POST /api/v1/policies/buy` through
wallet signing, `POST /api/v1/tx/submit`, and scheduled claim settlement by
`ClaimSettlementService`.  
**Review trigger:** Revisit when authentication, persistence, policy purchase
reconciliation, contract interfaces, or deployment topology changes.

## 1. System and security objectives

The backend builds an unsigned Soroban `buy_policy` invocation; the holder
signs it in a wallet; the backend accepts that signed transaction and submits
it to the Soroban RPC; and scheduled workers evaluate oracle readings and may
submit a relayer-signed `process_claim` transaction. The on-chain contract is
the authority for balances and transaction execution. The API also keeps
policy and settlement state in process memory.

Security objectives:

- Only the holder-authorized purchase or transaction is submitted; the
  backend must not forge user authorization.
- Contract execution, transaction confirmation, and local policy state must
  remain consistent; a pending or failed transaction must not be represented
  as active coverage or a paid claim.
- Only valid, fresh and appropriately trusted oracle data may drive automated
  payouts.
- The relayer secret and signed transaction material remain confidential and
  are not exposed through responses, logs, or unauthorised access.
- Public API and scheduler workloads must not be usable to exhaust backend,
  RPC, or relayer resources.

## 2. Data flows and trust boundaries

1. **Purchase request:** Browser/wallet -> `POST /api/v1/policies/buy` ->
   DTO validation and `PolicyService.buy()` -> Soroban RPC account lookup and
   transaction preparation -> unsigned XDR and policy details returned to
   caller. Trust boundary: untrusted HTTP client to backend. Validation is
   applied by the global Nest `ValidationPipe`; purchase policy data is
   currently stored in an in-memory map before the user signs or submits.
2. **Wallet authorization:** Caller -> wallet -> holder signature over the
   prepared XDR. Trust boundary: backend to user-controlled wallet. Signing
   must occur outside the backend; the wallet/user must verify transaction
   network, contract, method, arguments, fees, and expiration.
3. **Submission:** Caller -> `POST /api/v1/tx/submit` -> XDR parsing ->
   Soroban RPC `sendTransaction` -> confirmation polling -> response.
   Trust boundary: untrusted signed-XDR input to a public RPC relay. The
   endpoint accepts any valid signed transaction; it does not bind the
   transaction to a preceding buy request or authenticate its submitter.
4. **Oracle and scheduled claim evaluation:** External oracle APIs and mocked
   oracle implementations -> `OracleService` -> `OracleScheduler` broadcasts
   readings and `ClaimScheduler` evaluates active in-memory policies every
   five minutes. Trust boundary: external data providers and scheduler
   execution to backend decision logic. Some live-source failures produce a
   non-triggering degraded reading; two coverage sources remain mocked.
5. **Payout:** `ClaimService` -> `ClaimSettlementService` -> relayer key ->
   Soroban RPC -> pool contract -> confirmation polling -> local deactivation.
   Trust boundary: privileged backend relayer to public RPC and on-chain
   contract. A confirmed settlement is required before local deactivation,
   but retries, duplicate workers, and durable idempotency are not currently
   coordinated across processes.

## 3. STRIDE analysis

| STRIDE | Lifecycle threats and impact | Existing controls and gaps |
|---|---|---|
| **Spoofing** | A caller can claim a holder address in the purchase DTO or use an unrelated valid signed transaction at the generic submit endpoint. A compromised oracle provider or endpoint could impersonate a trustworthy data source and influence automated decisions. | Contract `require_auth` and wallet signatures protect contract-level user actions; HTTPS, origin policy, and upstream authenticity/availability are deployment responsibilities. The API does not authenticate callers or verify the signer/operation against a purchase intent; CORS is not authentication. |
| **Tampering** | A malicious client can alter transaction XDR, parameters, network, or destination before signing/submitting. Tampered, stale, malformed, or manipulated oracle responses could change a trigger decision. The local policy record can differ from the on-chain policy because it is created before user authorization/submission. | DTO validation and Soroban simulation constrain purchase input and contract execution; transaction signatures prevent edits after signing. There is no submit-time binding or post-confirmation reconciliation. Oracle checks use public APIs; provenance, freshness, independent corroboration, and response-shape bounds need strengthening. |
| **Repudiation** | A buyer or operator may dispute a purchase, signature, submission, oracle decision, or payout because evidence is not durably correlated across the complete flow. In-memory policy/history disappears on restart. | Soroban transaction hashes are returned on confirmation and some operations are logged. Durable, tamper-evident audit records linking request, signed transaction hash, oracle observation, policy ID, and settlement result are absent. |
| **Information Disclosure** | Public policy/claim endpoints may disclose holder addresses, purchase details, or claim history. Signed XDR and verbose exception messages may expose transaction or infrastructure details if logged or returned. A leaked relayer secret enables privileged contract actions. | No secret is intentionally returned by these transaction endpoints, Helmet is enabled, and the relayer key is configuration-driven. The claim history endpoints have no authorization, response minimization, retention policy, or access control; deployment secret management and log redaction are not enforced in code. |
| **Denial of Service** | Repeated purchase requests can cause account lookups/simulation; the generic submit route can trigger RPC submission and up to roughly 30 seconds of polling per request. Public endpoints have no rate/concurrency limits. Oracle/RPC outages can stall scheduled runs; retries can accumulate load. | Request DTO validation, RPC timeouts where configured, and error handling provide limited protection. Request body, transaction size/complexity, rate, concurrency, and per-caller budgets are not explicitly bounded here. Scheduler run overlap and distributed coordination are not guarded. |
| **Elevation of Privilege** | Compromise or misuse of `ORACLE_RELAYER_SECRET` grants the backend authority to submit privileged settlement transactions. A forged or compromised oracle result may trick the scheduler into exercising that authority. | User transactions are wallet-signed and settlement checks configuration, but relayer key scope/rotation, isolated signing, approvals, payout limits, and defense-in-depth validation are not present in this service. Contract authorization remains a critical control and must be independently reviewed. |

## 4. Prioritized follow-up checklist

Items below are tracked follow-ups, not claims that the current implementation
already addresses them. Priorities are initial risk ratings and should be
reassessed against deployment exposure and on-chain contract controls.

- [ ] **P0 — Reconcile purchase lifecycle with chain state.** Persist a
  purchase intent as pending, bind `POST /tx/submit` to the expected holder,
  network, contract, operation and intent, and only activate a policy after
  confirmed inclusion. Persist the actual on-chain policy ID returned by the
  contract. The current code creates an in-memory UUID policy before wallet
  authorization, while its documented `process_claim` interface expects a
  contract policy ID.
- [ ] **P0 — Verify and make settlement safe/idempotent.** Confirm the
  deployed `process_claim` signature and policy-ID type against contract
  source/ABI; correct the invocation; add durable claim states, uniqueness,
  retry/backoff, and single-worker/distributed locking so multiple instances
  cannot pay the same claim. Never treat a submission as payout until the
  contract confirms it.
- [ ] **P1 — Protect privileged relayer authority.** Move signing to a
  restricted secret manager or isolated signer, limit key permissions and
  funded balance, rotate/revoke credentials, audit signing, and add
  configurable per-claim and aggregate payout bounds.
- [ ] **P1 — Authenticate and constrain transaction submission.** Require
  caller authorization or a purchase-intent capability; decode and validate
  allowed network, source, contract, operation, time bounds and size before
  relay. Apply request-size limits, rate limits, concurrency limits, and
  bounded confirmation work.
- [ ] **P1 — Harden oracle decision inputs.** Validate schema, numeric range,
  timestamp/freshness, source identity and plausible movement; add independent
  corroboration or an operator pause for payout-triggering values. Replace
  mocked trigger sources before offering those coverages as live. See
  [section 6](#6-attack-cost-model-and-quorum-sizing) for the quantitative
  model that sizes corroboration thresholds and operator bonds.
- [ ] **P1 — Make lifecycle evidence durable.** Store purchase intent,
  transaction hash/status, oracle source/value/time, trigger decision,
  settlement hash/status, and administrative actions in durable append-only
  audit records with retention and alerting.
- [ ] **P2 — Minimize and control personal/transaction data exposure.** Define
  authorization and response policy for holder and claim-history endpoints;
  redact sensitive request/response fields and upstream error details from
  logs; document retention and deletion expectations.
- [ ] **P2 — Add operational resilience controls.** Prevent scheduler
  overlap, coordinate scheduled work across replicas, bound per-cycle work,
  use circuit breakers/backoff for dependencies, and alert on stale oracle
  inputs, settlement failures, and backlog age.

## 6. Attack-cost model and quorum sizing

Corroboration and "decentralized" are only meaningful if they translate into a
number: what does it cost an attacker to move this feed, and is that number
large relative to the maximum payout the feed can trigger? This section
documents the analytical model implemented in `scripts/attack-cost-model.ts`
(pure function library) and `scripts/attack-cost.ts` (operator CLI). The model
is versioned (`MODEL_VERSION`) alongside the quorum policy it validates; any
change to the formulas below must bump the version and update this section.

### 6.1 Inputs

A feed definition supplies:

- `sources[]`: each source has an `id`, a `bond` (the capital the source must
  post, in stroops, as a bigint), and an optional `independence` weight in
  `[0, 1]` relative to the other sources. **Unknown independence is treated as
  fully dependent (`0`)**, i.e. the worst case: a source with no declared
  independence contributes no diversity and cannot be counted on to resist
  collusion.
- `quorum`: the number of source confirmations required to trigger a payout
  (`threshold`), and the total number of sources consulted (`total`).
- `operatorKeys`: the number of distinct relayer/operator keys that can submit
  a settlement, and the `bond` each operator posts.
- `maxExposure`: the maximum payout the feed can trigger (dynamic feeds
  recompute this from pool TVL before validation).

A quorum policy supplies `safetyFactor` (default `10`): the modeled attack cost
must exceed the exposure by at least this multiple.

All arithmetic uses `bigint` for bonds and costs and integer basis points for
independence weights, so large values cannot overflow and no floating-point
rounding enters the security decision.

### 6.2 Cost formulas

1. **Source-bribery cost.** To bribe the cheapest `threshold` sources to
   confirm a false reading, the attacker must outbid their bonds. With
   independence weights `w_i`, the effective cost of bribing source `i` is
   `bond_i * (1 + w_i)` (a more independent source is harder to bribe because
   it must also be induced to break with its independent peers). The bribery
   cost is the sum of the `threshold` smallest effective costs.
2. **Collusion-threshold cost.** The residual risk after corroboration is that
   `threshold` sources collude. The model computes the cheapest colluding set
   of size `threshold` under the same effective-cost ordering and reports it
   separately, so operators can see the marginal cost of raising `threshold`
   by one. Sources with unknown independence are grouped as fully dependent, so
   collusion among them is priced at their bare bonds.
3. **Key-compromise cost.** To compromise `k` operator keys the attacker must
   defeat `k` bonds plus the operational cost of key compromise; the model
   reports `k * operatorBond` for `k = 1..operatorKeys` and the minimum `k`
   needed to reach the settlement threshold. The overall attack cost is
   `min(bribery, collusion, keyCompromise)` — the cheapest path an attacker
   would take.

### 6.3 Derived minimum bond and maximum supported exposure

Given a target `maxExposure` and `safetyFactor`, the model derives the minimum
per-source bond such that `attackCost >= maxExposure * safetyFactor`, and the
maximum exposure a feed can support for its current bonds:
`maxSupportedExposure = attackCost / safetyFactor`. Zero-bond configurations
yield zero attack cost and therefore support zero exposure; they are reported
explicitly rather than silently accepted.

### 6.4 Published reference scenario

The regression fixture `scripts/__fixtures__/attack-cost-reference.json`
encodes the following hand-computed scenario and is asserted by the unit tests:

- 5 sources, each bond `1_000_000` stroops; independence weights
  `[1.0, 0.8, 0.5, 0.0, 0.0]` (the last two unknown -> fully dependent).
- Quorum `threshold = 3` of `total = 5`.
- 3 operator keys, each bond `2_000_000` stroops; settlement threshold 2 keys.
- `safetyFactor = 10`.

Hand computation (effective bribery cost `bond * (1 + w)` in stroops):

| source | bond | w | effective cost |
|---|---|---|---|
| s1 | 1,000,000 | 1.0 | 2,000,000 |
| s2 | 1,000,000 | 0.8 | 1,800,000 |
| s3 | 1,000,000 | 0.5 | 1,500,000 |
| s4 | 1,000,000 | 0.0 | 1,000,000 |
| s5 | 1,000,000 | 0.0 | 1,000,000 |

- Bribery cost (3 cheapest): `1,000,000 + 1,000,000 + 1,500,000 = 3,500,000`.
- Collusion cost (3 cheapest, bare bonds for dependent sources):
  `1,000,000 + 1,000,000 + 1,500,000 = 3,500,000`.
- Key-compromise cost (2 keys): `2 * 2,000,000 = 4,000,000`.
- **Attack cost = min(3,500,000; 3,500,000; 4,000,000) = 3,500,000 stroops.**
- **Max supported exposure at safety factor 10 = 3,500,000 / 10 = 350,000
  stroops.**

Reproduce with:

```
npx ts-node scripts/attack-cost.ts \
  --feed scripts/__fixtures__/attack-cost-reference.json \
  --safety-factor 10
```

The CLI prints the attack cost, the maximum supported exposure, and the implied
minimum bond for a requested exposure, all as exact integers.

### 6.5 Startup validation rule

Configuration validation (`validateFeedSecurity`) runs at startup for every
payout-triggering feed. It refuses to start when
`maxExposure * safetyFactor > attackCost`, i.e. when the exposure the feed can
trigger exceeds the modeled attack cost by the configured safety factor. The
error names the feed, the modeled attack cost, the exposure, and the safety
factor so an operator can either raise bonds/quorum or lower exposure. Feeds
whose exposure is dynamic are re-validated whenever pool TVL changes the
exposure; a feed that cannot be priced (unknown sources, zero bonds) fails
closed. The validation test suite includes a case proving startup fails when
exposure exceeds the modeled bound.

## 5. Assumptions and limitations

- This assessment covers the backend code paths named above, not frontend
  wallet UX, contract implementation, RPC-provider internals, cloud IAM,
  network policy, or production secret management.
- Contract authorization and invariants are assumed to exist but are not
  independently verified here. The settlement service source explicitly
  documents an unresolved contract argument/signature mismatch; do not deploy
  automated settlement as production-ready until the P0 verification item is
  closed.
- This document is a threat-model baseline, not a penetration test or proof
  that all vulnerabilities have been found. Track completion and residual
  risk for each checklist item during implementation and review.
- The attack-cost model in section 6 is an analytical estimate, not a market
  observation. It assumes an attacker must outbid posted bonds and does not
  price operator capital, liquidity, or the staking/slashing mechanics
  themselves (tracked separately). Independence weights are operator-declared
  inputs; unknown independence is conservatively treated as fully dependent.
