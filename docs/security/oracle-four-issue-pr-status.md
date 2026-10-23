# Oracle remediation, deduplication, red-team, and evidence PR status

This draft consolidates work for issues #263–#266. It is not ready to merge as
a production implementation.

## Current scope and limitations

- Claim remediation currently has an in-memory state machine. It is not
  durable across process restarts, is not exposed through an authenticated
  operator workflow, and does not verify an on-chain settlement before
  accepting an execution reference.
- Reading deduplication currently provides deterministic local grouping and
  reason records, but it is not connected to a PostgreSQL uniqueness
  constraint or the production consensus path.
- The adversarial helper no longer fabricates successful outcomes. All
  scenarios remain blocked until an authorized staging executor records
  attack and retest observations. No staging exercise was executed for this
  PR.
- The evidence encryptor provides authenticated field encryption and
  row-integrity MACs as a helper, but it is not wired into evidence-table
  writes, database roles, or a scheduled integrity verifier.

## Validation

The seven focused `node:test` cases passed using Node's TypeScript stripping
support. The repository's tracked `package.json` is empty, so the normal
project test/build commands cannot be run from `main`. An older available
branch also fails its build; neither branch provides a clean integration
baseline.

Do not treat this draft as production-ready or merge it until the persistence,
authorization, and pipeline integrations above are completed and the staging
exercise has been executed and reviewed.
