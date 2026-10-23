# Oracle pipeline adversarial exercise

## Scope

The exercise plan covers six synthetic attack scenarios: forged provider
submissions, replayed readings, provider-response substitution, dependent
provider collusion, operator privilege escalation, and use of a compromised
relayer identity. Payloads and credentials used for an exercise must be
synthetic. Never run these scenarios against a third-party provider or a live
network.

## Execution requirements

Each scenario requires an explicit executor connected to an isolated staging
deployment configured with production-equivalent trust controls. The executor
must record the observed result for both the attack and a retest. A local
simulation is useful for regression testing but is not staging evidence.

The test helper in `src/oracle/redteam/adversarialRedTeamSuite.ts` reports
scenarios without an executor as blocked. It does not infer that a control
exists, and it only reports a scenario as verified when both its attack and
retest are observed in staging and blocked as expected.

## Current execution record

**Status: not executed against staging.** No staging deployment or authorized
executor was supplied in this work session. Therefore all six scenarios are
blocked, and there are no verified findings, retests, or claims that the
pipeline is safe. The unit tests only verify that the reporting helper does
not turn missing or simulated execution into a staging pass.

| Scenario | Status | Required evidence |
|---|---|---|
| Forged unsigned provider submission | Blocked | Staging rejection response and audit entry |
| Replayed reading envelope | Blocked | One-vote evidence and duplicate decision reason |
| Spoofed provider response | Blocked | Staging transport/provenance result |
| Colluding source pair | Blocked | Independence-group quorum decision |
| Operator privilege escalation | Blocked | Authorization rejection and audit entry |
| Compromised relayer identity | Blocked | Staging rejection/hold and security event |

Do not mark an item verified until the staging observations, retest result,
and any linked remediation issue have been reviewed and recorded.
