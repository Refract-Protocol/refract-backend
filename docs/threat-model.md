# Refract Backend Transaction Lifecycle Threat Model

**Assessment date:** 2026-09-30
**Status:** Design-time STRIDE assessment; follow-ups are open
**Scope:** `POST /api/v1/policies/buy` through wallet authorization and
`POST /api/v1/tx/submit`, then scheduled oracle evaluation and automated
settlement through `ClaimSettlementService`.
**Reassessment triggers:** Changes to the contract interface, purchase or
submission APIs, oracle providers/decision rules, persistence, relayer
permissions, or deployment topology.

## 1. Purpose, security objectives, and risk method

This assessment identifies threats to the confidentiality, integrity, and
availability of the transaction and claim-settlement lifecycle. It is based
on the backend implementation and its stated contract interface; it is not a
contract audit, penetration test, or verification of production deployment
controls.

Security objectives:

1. Only the holder-authorized transaction is executed on-chain, and the
   backend cannot silently change what the wallet is asked to sign.
2. Local policy and claim state reflects confirmed on-chain state; incomplete,
   failed, or ambiguous transactions are not reported as active coverage or
   paid claims.
3. Settlement decisions use authentic, valid, sufficiently fresh oracle data
   and cannot be triggered by an untrusted or malformed reading.
4. The relayer signing key, user transaction data, and sensitive holder data
   are protected from unauthorized access and disclosure.
5. Untrusted API traffic, upstream failures, retries, or duplicate workers
   cannot exhaust the backend, RPC budget, or relayer authority.
6. Purchase, oracle, and settlement events have durable evidence sufficient
   to investigate disputes and incidents.

Risk ratings are qualitative initial prioritizations, not measured
likelihoods. **P0** means a release-blocking integrity or settlement
correctness issue; **P1** means a high-priority security or reliability
control; **P2** means a defense-in-depth/privacy improvement. Reassess the
ratings against actual deployment exposure and independently verified
contract controls.

## 2. System description and lifecycle

### Components and data flow

1. **Purchase preparation:** An unauthenticated HTTP caller sends holder,
   coverage type/amount, duration, and optional trigger parameters to
   `POST /api/v1/policies/buy`. DTO validation enforces basic formats and
   ranges. `PolicyService.buy()` checks catalog and on-chain coverage bounds,
   calculates a premium, creates a local UUID policy marked active, and
   returns it with an unsigned, simulation-prepared Soroban `buy_policy`
   transaction. The in-memory policy is stored before the transaction is
   built and before the caller signs or submits it.
2. **Wallet authorization:** The caller presents the unsigned XDR to a
   user-controlled wallet. The holder is expected to review and sign the
   transaction. The backend does not participate in signing this user
   transaction.
3. **Submission and confirmation:** The caller posts signed XDR to
   `POST /api/v1/tx/submit`. `TxService` parses it using the configured
   network passphrase, sends it to Soroban RPC, and polls for up to 15
   attempts at two-second intervals. It accepts any parsable signed
   transaction; it does not bind the envelope to the preceding purchase,
   holder, contract, or operation. A confirmed purchase is not reconciled
   with the locally-created UUID policy or its eventual on-chain policy ID.
4. **Oracle evaluation:** `ClaimScheduler` runs every five minutes and
   scans active, unexpired policies in the in-memory `PolicyService` map.
   `ClaimService` fetches a reading for each policy and compares its value
   with the returned threshold. Three checks use external public sources
   (CoinGecko for USDC/XLM prices and DeFiLlama for TVL); LiquidationShield
   and FlightDelay readings are mocked. `OracleScheduler` separately polls
   selected feeds every minute for WebSocket alerts; the claim scan obtains
   its own readings.
5. **Automated settlement:** For a triggered reading, `ClaimService` calls
   `ClaimSettlementService`, which constructs and signs a `process_claim`
   call with the configured relayer key, submits it, and waits for
   confirmation. A confirmed result deactivates the local policy and adds
   an in-memory history entry. A failed or unconfirmed result leaves the
   policy active for a later retry.

### Trust boundaries

- **TB1 — Public client to API:** Request bodies, holder identifiers,
  transaction envelopes, and request frequency are untrusted.
- **TB2 — Client to wallet:** Wallet approval and transaction display are
  outside the backend's control; users must verify network, contract,
  operation, arguments, fees, and expiration before signing.
- **TB3 — Backend to RPC / chain:** The backend trusts RPC responses for
  simulation, submission, and confirmation. The chain is authoritative for
  execution, but local state is not currently reconciled with it.
- **TB4 — Oracle providers to decision logic:** External provider responses
  and mocked readings influence privileged settlement decisions.
- **TB5 — Relayer secret to privileged signing:** `ORACLE_RELAYER_SECRET`
  enables backend-signed contract calls and must be treated as a high-impact
  credential.
- **TB6 — Scheduler instances and process memory:** Scheduler execution and
  in-memory policies/history are local to a process; restarts and multiple
  replicas can diverge or repeat work.

### Assets and security assumptions

Assets include the relayer private key and signing authority, pool funds,
user-held funds and signed transactions, policy/claim state, holder
addresses, oracle observations and decisions, service/RPC availability, and
audit evidence. This assessment assumes wallet signatures and the configured
network passphrase are used correctly. Contract authorization and payout
invariants are not independently verified here. HTTPS, deployment IAM,
secret-manager controls, RPC-provider behavior, and frontend wallet behavior
are outside the code-level assessment.

## 3. STRIDE analysis

| STRIDE | Threat scenarios and impact | Existing controls and residual gaps | Priority |
|---|---|---|---|
| **Spoofing** | A caller supplies another holder's address to create a local policy record or uses the generic submit endpoint to relay a transaction unrelated to that purchase. A compromised or substituted oracle endpoint can pose as a trusted data source and influence claim decisions. | Purchase DTO validation checks address length, not ownership. Wallet signatures and contract `require_auth` are expected to authorize on-chain user actions, but the API has no caller authentication, transaction-to-intent binding, or oracle source authentication/corroboration. CORS origin restriction is not authentication. | P1 |
| **Tampering** | A caller changes purchase arguments before wallet signing or submits a different valid signed transaction. The local record is marked active before wallet authorization/submission and can diverge from chain state; an RPC failure while building the XDR can leave a phantom policy. Oracle responses that are malformed, manipulated, implausible, or stale can produce incorrect trigger decisions. | Signature verification and contract validation protect an accepted on-chain transaction from post-signing edits. DTO checks and transaction simulation provide limited validation. There is no confirmed-purchase reconciliation. Claim freshness is calculated from just before the request until evaluation, not from a trusted source timestamp; schema/range/provenance checks and independent corroboration are absent. | P0 |
| **Repudiation** | A buyer, operator, or service owner may be unable to establish which purchase intent, signed envelope, oracle observation, decision, or settlement belongs to a reported policy. Process restart loses policy and claim history; logs and returned hashes do not form a complete durable audit trail. | The submit response may include a transaction hash and services log selected errors/outcomes. No durable correlated record captures request/intent, signed transaction hash and status, on-chain policy ID, source reading, decision, relayer action, or settlement status. | P1 |
| **Information Disclosure** | Public holder-policy and claim-history routes reveal holder addresses and activity without caller authorization. Purchase and submit error responses can include upstream exception text; operational details may be exposed. Relayer-secret compromise exposes privileged signing authority. | Helmet and a configured CORS origin are enabled, but neither authorizes access. No endpoint-level authorization or response minimization is evident for holder/history routes. Signed XDR is not intentionally returned beyond the caller's request/response flow, but upstream error messages are passed through in some responses. Secret storage, access, rotation, and log-redaction guarantees depend on deployment. | P2 |
| **Denial of Service** | Repeated purchase calls trigger account lookup and simulation; transaction submissions consume RPC capacity and can occupy request work for approximately 30 seconds of confirmation polling. Concurrent scans, repeated settlement attempts, slow providers, or RPC outages can exhaust API, RPC, or relayer resources. | DTO validation and finite confirmation polling constrain some work. No application-level rate/concurrency budget or scheduler overlap/distributed lock is implemented in these paths. Oracle HTTP calls have configured timeouts, but retries/backoff, cycle budgets, and dependency circuit breaking are limited or absent. | P1 |
| **Elevation of Privilege** | Theft or misuse of the relayer key gives an attacker the backend's ability to sign settlement calls. A faulty or manipulated decision path may cause that authority to be exercised incorrectly. An overly broad relayer permission/funding level magnifies impact. | The secret is configuration-driven and settlement requires it to be present, but this does not constrain its authority. Isolated signing, key rotation/revocation, least privilege, payout limits, independent approval/pause, and signing audit are not enforced in this service. Contract-level authorization and limits require separate verification. | P1 |

### Known release-blocking correctness issue

`ClaimSettlementService` documents that the contract's `process_claim` is
`process_claim(policy_id: u64)` and returns the payout amount, but the service
currently passes three arguments (`String` policy ID, holder address, payout
amount). It also receives the backend-generated UUID, not a confirmed
on-chain `u64` policy ID. Per the service's documented contract interface,
the invocation will fail simulation; settlement must not be represented as
production-ready until the deployed interface and end-to-end ID flow are
verified and corrected. This is both an availability/correctness issue and a
release gate for automated settlement. A fix to the argument list alone
would not close the missing purchase reconciliation or retry/idempotency
risks.

## 4. Tracked follow-up checklist

These repository checkboxes are the follow-up register. Keep each item open
until its acceptance criteria are met and evidence is linked in the change
that closes it. The accountable role is a suggested owner; assign a named
owner when work is scheduled. Do not mark an item complete based only on
documentation or a unit test where integration evidence is required.

- [ ] **TM-01 — P0 — Reconcile purchases to confirmed chain state**

  **Owner:** Backend
  **Acceptance:** Persist purchase intents as pending; bind submission to the
  expected intent, holder, network, contract, operation, and arguments; only
  activate after confirmed on-chain success; persist the actual contract
  policy ID; make failed XDR preparation/signature/submission incapable of
  creating an active policy. Include integration coverage for success,
  rejection, timeout, and restart/replay.
- [ ] **TM-02 — P0 — Verify and correct settlement contract integration**

  **Owner:** Backend + smart-contract
  **Acceptance:** Verify `process_claim` ABI and policy-ID type against the
  deployed contract artifact/source; pass the confirmed on-chain ID and
  exact ABI arguments; prove in an integration test that a valid triggered
  claim settles and an invalid/already-settled claim cannot pay.
- [ ] **TM-03 — P0 — Make settlement durable and idempotent**

  **Owner:** Backend
  **Acceptance:** Persist claim state transitions and settlement hashes;
  enforce uniqueness per policy/claim; coordinate workers across replicas;
  handle ambiguous submission/confirmation outcomes without duplicate
  payout; use bounded retry/backoff and reconcile pending transactions.
- [ ] **TM-04 — P1 — Constrain and authorize transaction relay**

  **Owner:** Backend
  **Acceptance:** Add an authenticated caller or unguessable, expiring
  purchase-intent capability; decode and enforce expected source, network,
  contract, operation, intent, time bounds, and transaction size; reject
  unrelated envelopes. Add API rate and concurrency limits and tests for
  replay and wrong-operation submissions.
- [ ] **TM-05 — P1 — Validate and govern oracle inputs**

  **Owner:** Backend + oracle/product
  **Acceptance:** Validate response schema, finite/ranged values, source
  identity, observation timestamps and freshness; define failure behavior;
  independently corroborate or require an operator pause for payout-grade
  signals; test stale, malformed, outlier, and provider-compromise cases.
  Replace mocked LiquidationShield and FlightDelay inputs before representing
  those coverages as production-backed.
- [ ] **TM-06 — P1 — Protect and bound relayer authority**

  **Owner:** Operations + smart-contract
  **Acceptance:** Store signing credentials in an approved secret manager or
  isolated signer; document access, rotation, revocation, and incident
  procedures; minimize key permissions and funded balance; define and enforce
  per-claim/aggregate payout limits or independent approval; alert on every
  privileged signing action.
- [ ] **TM-07 — P1 — Add durable lifecycle audit evidence**

  **Owner:** Backend + operations
  **Acceptance:** Persist correlated purchase intent, transaction hash/status,
  on-chain policy ID, oracle provider/value/observation time, decision,
  settlement hash/status, and operator actions in access-controlled,
  tamper-resistant records with retention and alerting.
- [ ] **TM-08 — P1 — Bound public and scheduled workloads**

  **Owner:** Backend + operations
  **Acceptance:** Enforce request size/rate/concurrency budgets, per-cycle
  policy limits, scheduler single-flight/distributed coordination, bounded
  retries/backoff, and dependency circuit breakers; alert on stale inputs,
  failed settlement, and growing backlog. Verify behavior under concurrent
  requests, slow RPC, and multiple service replicas.
- [ ] **TM-09 — P2 — Minimize and protect exposed data**

  **Owner:** Backend + privacy
  **Acceptance:** Define access policy for holder, policy, and claim-history
  endpoints; minimize returned fields; redact signed transaction material,
  secrets, and upstream internals from logs and API errors; establish data
  retention/deletion rules and test unauthorized access.

## 5. Residual risk and limitations

- Automated settlement is not production-ready while TM-02 and TM-03 remain
  open; the documented argument mismatch currently blocks successful
  settlement, and the purchase flow does not supply the required on-chain
  policy ID.
- The assessment does not establish that contract authorization, payout
  accounting, oracle logic on-chain, RPC behavior, TLS, cloud IAM, secret
  management, or frontend transaction review are secure.
- This threat model is a design baseline, not proof that the listed scenarios
  are exhaustive. Reassess it after architecture or deployment changes and
  close checklist items with implementation and verification evidence.
