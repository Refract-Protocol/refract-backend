# Security Policy

Refract is a financial protocol that custodies user funds. We take security
seriously and appreciate responsible disclosure.

## Status

⚠️ **Pre-audit / testnet only.** Refract has **not** undergone a professional
security audit. Do not deploy to mainnet or custody real value until it has.

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Instead, email **security@refract.example** with:

- A description of the issue and its impact
- Steps to reproduce (proof-of-concept where possible)
- Affected contract/service and version/commit

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
transport-security protections. The backend serves API responses rather than
application HTML; CSP is defense-in-depth and is not a substitute for safe
frontend rendering. Production TLS should terminate at a trusted proxy, which
must preserve HTTPS semantics so browsers can apply HSTS correctly.

### Deployment assumptions

The origin allowlist protects browser response access, not API availability,
identity, authorization, replay, or transaction correctness. State-changing
operations still depend on Soroban wallet signatures and on-chain authorization.
All deployments should use HTTPS, restrict access to trusted origins, configure
the actual production/staging URLs explicitly, and treat exposed or compromised
frontend deployments as untrusted until investigated.
