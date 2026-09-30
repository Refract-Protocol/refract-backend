# Security Policy

Refract is a financial protocol that custodies user funds. We take security
seriously and appreciate responsible disclosure.

## Status

⚠️ **Pre-audit / testnet only.** Refract has **not** undergone a professional
security audit. Do not deploy to mainnet or custody real value until it has.

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

### Structured intake (primary mechanism)

Submit reports through the authenticated intake API at
`POST /api/v1/security-reports`. This is the **primary reporting mechanism**;
the email address below is retained only as a fallback for reporters who
cannot use the API.

The endpoint requires authentication and a submitter identity/contact so that
reports are trackable and anonymous spam is prevented. Each report is
structured with:

- `severity` — one of `low`, `medium`, `high`, `critical`
- `affectedComponent` — the contract/service/component affected
- `description` — a description of the issue and its impact
- `reproductionSteps` — steps to reproduce (proof-of-concept where possible)
- `submitterName` and `submitterContact` — who to follow up with

Reports are persisted with a triage status workflow:
`new` → `triaging` → `resolved` / `wontfix`. On submission, a notification is
sent to the team's configured communication channel so reports do not sit
unnoticed.

**Confidentiality:** report contents — especially reproduction steps for
unpatched vulnerabilities — are never exposed via any public or list endpoint.
Only authenticated triagers may read a report's contents; a non-triager can
never read another submitter's report. Triage access is controlled by the same
admin-only guard used elsewhere in the API.

### Email fallback

If you cannot use the intake API, email **security@refract.example** with the
same structured fields listed above.

We aim to acknowledge reports within **72 hours** and to provide a remediation
timeline after triage. We will credit reporters who wish to be named once a fix
ships.

## Scope

In scope: the smart contracts, the backend services, and the web app in the
Refract repositories. Out of scope: third-party dependencies (report upstream),
testnet-only configuration, and theoretical issues without a practical impact.

## Known limitations (by design, pre-audit)

- The oracle is **permissioned** (admin/relayer submitted). Decentralizing it is
  on the roadmap.
- Trigger thresholds are set at deployment and changed only via admin.
- Mainnet deployment is intentionally gated until an external audit completes.

## HTTP security configuration and threat model

### CORS

`FRONTEND_URLS` is a comma-separated allowlist of exact `http`/`https`
origins, for example
`https://app.example.com,https://staging.example.com`. Entries cannot include
paths, credentials, query strings, fragments, or wildcards. `FRONTEND_URL`
remains a single-origin fallback for older deployments. An empty list or
malformed entry prevents startup rather than silently widening access.

The API does not enable credentialed CORS: it does not use browser cookies or
HTTP authentication sessions. CORS limits which browser origins may read
responses; it is **not authentication**, does not prevent direct HTTP clients,
and does not protect state-changing routes from callers who can reach the API.
Mobile applications and third-party server integrations do not rely on CORS
and must use a separately authenticated API interface before being trusted.
Only deploy origins controlled by the team; an allowed but compromised
frontend can make authenticated-looking requests as its users.

### Helmet

Helmet's default middleware configuration remains enabled, including its
content-security, content-type-sniffing, referrer, framing, cross-origin, and
transport-security protections. Its default CSP directives are explicit;
`upgrade-insecure-requests` is enabled when `NODE_ENV=production` and omitted
otherwise so HTTP development assets are not unexpectedly upgraded.
The backend serves API responses rather than application HTML; CSP is
defense-in-depth and is not a substitute for safe frontend rendering.
Production TLS should terminate at a trusted proxy, which must preserve HTTPS
semantics so browsers can apply HSTS correctly.

### Deployment assumptions

The origin allowlist protects browser response access, not API availability,
identity, authorization, replay, or transaction correctness. State-changing
operations still depend on Soroban wallet signatures and on-chain authorization.
All deployments should use HTTPS, restrict access to trusted origins, configure
the actual production/staging URLs explicitly, and treat exposed or compromised
frontend deployments as untrusted until investigated.

Signed transaction submissions are reserved atomically by transaction hash in
Redis before reaching Soroban RPC. The record expires one hour after the XDR's
maximum time bound; expired or unbounded transactions are rejected, and a
duplicate is reported without a second network submission. Redis is therefore
required for this endpoint and must be shared by every API replica. If Redis is
unavailable, submission fails closed; do not bypass this guard to restore
availability. Configure the Redis instance with enough capacity and a
non-evicting policy for these keys; eviction before the transaction expires
would remove the application-level replay record.

## State-change audit events

The API emits one structured `security_audit` JSON event for each invocation
of `POST /api/v1/pool/provide`, `POST /api/v1/pool/withdraw`,
`POST /api/v1/policies/buy`, and `POST /api/v1/tx/submit`. Both successful and
failed attempts are recorded, with an ISO-8601 timestamp, request ID, action,
HTTP route/status, outcome, caller identity hints, and allowlisted change
fields. The quote endpoint is a read-only POST and is intentionally not
classified as a state change.

Address identity from a request body is explicitly recorded as a caller
**claim**, not an authenticated identity. Transaction submission records the
Soroban transaction source address. If an `X-API-Key` is present, only its
truncated SHA-256 fingerprint is recorded; the raw key and signed XDR are never
logged. The `changes` object contains only action-specific fields, not arbitrary
request bodies.

Audit records use a dedicated Winston JSON logger and are written as JSON lines
to stdout, separately from the Nest/application logger's human-oriented output.
Production deployments should collect stdout and route records where
`event=security_audit` to a durable log aggregation or SIEM destination. The
application does not claim durable audit delivery if the process or collector
is unavailable; production operators must monitor the log pipeline and retain
records according to their incident-response and compliance requirements.
