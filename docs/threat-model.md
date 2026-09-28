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
  mocked trigger sources before offering those coverages as live.
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
