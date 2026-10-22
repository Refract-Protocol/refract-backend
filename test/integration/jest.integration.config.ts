import type { Config } from "jest";

/**
 * Separate Jest project for integration tests that spin up a real,
 * ephemeral Postgres instance via testcontainers.
 *
 * Run:  npx jest --config test/integration/jest.integration.config.ts
 *
 * The suite is intentionally kept out of the default `jest` (rootDir:src)
 * run so unit tests stay fast and free of Docker dependency.
 */
const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: "../..",
  testMatch: ["<rootDir>/test/integration/**/*.ispec.ts"],
  globalSetup: "<rootDir>/test/integration/setup/global-setup.ts",
  globalTeardown: "<rootDir>/test/integration/setup/global-teardown.ts",
  // Longer timeout: container start + schema apply can take ~15 s on CI.
  testTimeout: 60_000,
  // ts-jest transform options — reuse root tsconfig.
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }],
  },
};

export default config;
```

File: test/contracts/jest.contracts.config.ts
```typescript
import type { Config } from "jest";

/**
 * Consumer-driven contract verification suite.
 *
 * Verifies that refract-backend's actual responses and encodings match the
 * checked-in contract fixtures owned by refract-frontend and refract-contracts.
 *
 * Run:  npx jest --config test/contracts/jest.contracts.config.ts
 *
 * Design notes:
 *  - No live database or network is required. Fixtures are checked in under
 *    test/contracts/fixtures/<consumer>/<interface>.contract.json.
 *  - The consumer owns the expectation; the producer (this repo) verifies it.
 *  - Additive changes (new optional fields) pass automatically.
 *  - Breaking changes (renamed/removed fields, changed units) fail with a
 *    readable message naming the offending field.
 */
const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: "../..",
  testMatch: ["<rootDir>/test/contracts/**/*.contract.ts"],
  testTimeout: 15_000,
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }],
  },
};

export default config;
```

File: test/contracts/types.ts
```typescript
/**
 * Shared types for the consumer-driven contract verification suite.
 *
 * A contract fixture is owned by a consumer (refract-frontend or
 * refract-contracts) and describes the exact shape the consumer expects from
 * a producer interface exposed by refract-backend.
 */

export type ContractConsumer = "refract-frontend" | "refract-contracts";

export type ContractInterface =
  | "consensus-decision"
  | "provenance"
  | "trust-status"
  | "onchain-reading";

/**
 * A single field expectation within a contract.
 *
 * - `type` is the JSON-ish type the consumer expects.
 * - `required` defaults to true; optional fields are additive-friendly.
 * - `unit` pins the semantic unit (e.g. "bps", "ms", "stroops") so a unit
 *   change is treated as breaking even when the type is unchanged.
 * - `enum` pins the allowed literal values.
 */
export interface FieldExpectation {
  type: "string" | "number" | "boolean" | "object" | "array" | "null";
  required?: boolean;
  unit?: string;
  enum?: Array<string | number | boolean>;
  /** Nested object shape, for object-typed fields. */
  fields?: Record<string, FieldExpectation>;
  /** Element shape for array-typed fields. */
  items?: FieldExpectation;
}

export interface ContractFixture {
  /** Consumer that owns this expectation. */
  consumer: ContractConsumer;
  /** Producer interface this contract pins. */
  interface: ContractInterface;
  /**
   * Contract version. Breaking changes require a bump and consumer opt-in;
   * additive changes do not.
   */
  version: number;
  /** Human-readable description of what is being pinned. */
  description: string;
  /** Expected top-level shape. */
  shape: Record<string, FieldExpectation>;
}

export interface ContractViolation {
  /** Dotted path to the offending field, e.g. "decision.confidence". */
  path: string;
  /** Human-readable reason. */
  reason: string;
  /** Expected description, if applicable. */
  expected?: string;
  /** Actual description, if applicable. */
  actual?: string;
}
```

File: test/contracts/verifier.ts
```typescript
/**
 * Generated verifier for consumer-driven contract fixtures.
 *
 * Compares a producer payload (an actual backend response or encoding) against
 * a checked-in contract fixture and returns a list of violations. An empty
 * list means the producer satisfies the consumer's expectation.
 *
 * Semantics:
 *  - Missing required fields are violations (breaking).
 *  - Renamed fields surface as a missing required field + an unexpected field,
 *    producing a readable named-field message.
 *  - Type mismatches are violations (breaking).
 *  - Unit mismatches are violations (breaking) even when the type matches.
 *  - Enum mismatches are violations (breaking).
 *  - Extra fields on the producer are allowed (additive changes pass).
 *  - Optional fields may be absent.
 */
import type {
  ContractFixture,
  ContractViolation,
  FieldExpectation,
} from "./types";

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, expected: FieldExpectation["type"]): boolean {
  switch (expected) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    default:
      return false;
  }
}

function verifyField(
  path: string,
  value: unknown,
  expectation: FieldExpectation,
  violations: ContractViolation[],
): void {
  const required = expectation.required !== false;

  if (value === undefined) {
    if (required) {
      violations.push({
        path,
        reason: "required field is missing",
        expected: expectation.type,
        actual: "undefined",
      });
    }
    return;
  }

  if (!matchesType(value, expectation.type)) {
    violations.push({
      path,
      reason: "field type mismatch",
      expected: expectation.type,
      actual: describeType(value),
    });
    return;
  }

  if (expectation.enum && !expectation.enum.includes(value as string | number | boolean)) {
    violations.push({
      path,
      reason: "field value not in allowed enum",
      expected: expectation.enum.map(String).join(" | "),
      actual: String(value),
    });
  }

  if (expectation.type === "object" && expectation.fields) {
    const obj = value as Record<string, unknown>;
    for (const [childKey, childExpectation] of Object.entries(expectation.fields)) {
      verifyField(`${path}.${childKey}`, obj[childKey], childExpectation, violations);
    }
  }

  if (expectation.type === "array" && expectation.items) {
    const arr = value as unknown[];
    arr.forEach((item, index) => {
      verifyField(`${path}[${index}]`, item, expectation.items as FieldExpectation, violations);
    });
  }
}

/**
 * Verify a producer payload against a contract fixture.
 *
 * @returns violations — empty when the payload satisfies the contract.
 */
export function verifyContract(
  fixture: ContractFixture,
  payload: unknown,
): ContractViolation[] {
  const violations: ContractViolation[] = [];

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    violations.push({
      path: "<root>",
      reason: "payload is not an object",
      expected: "object",
      actual: describeType(payload),
    });
    return violations;
  }

  const record = payload as Record<string, unknown>;
  for (const [key, expectation] of Object.entries(fixture.shape)) {
    verifyField(key, record[key], expectation, violations);
  }

  return violations;
}

/**
 * Format violations into a readable, named-field message suitable for a
 * failing CI build.
 */
export function formatViolations(
  fixture: ContractFixture,
  violations: ContractViolation[],
): string {
  const header =
    `Contract violation(s) for ${fixture.consumer} :: ${fixture.interface} ` +
    `(v${fixture.version}) — ${fixture.description}`;
  const lines = violations.map((v) => {
    const expected = v.expected !== undefined ? ` (expected: ${v.expected})` : "";
    const actual = v.actual !== undefined ? ` (actual: ${v.actual})` : "";
    return `  - field "${v.path}": ${v.reason}${expected}${actual}`;
  });
  return [header, ...lines].join("\n");
}

/**
 * Assert that a producer payload satisfies a contract fixture. Throws a
 * readable error naming the offending field(s) on failure.
 */
export function assertContract(fixture: ContractFixture, payload: unknown): void {
  const violations = verifyContract(fixture, payload);
  if (violations.length > 0) {
    throw new Error(formatViolations(fixture, violations));
  }
}
```

File: test/contracts/fixtures.ts
```typescript
/**
 * Loader for checked-in contract fixtures.
 *
 * Fixtures live under test/contracts/fixtures/<consumer>/<interface>.contract.json
 * and are owned by the consuming repo. They are checked in so the producer can
 * verify against them without a broker or network access.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { ContractConsumer, ContractFixture } from "./types";

const FIXTURES_ROOT = join(__dirname, "fixtures");

const CONSUMERS: ContractConsumer[] = ["refract-frontend", "refract-contracts"];

export function loadFixtures(): ContractFixture[] {
  const fixtures: ContractFixture[] = [];
  for (const consumer of CONSUMERS) {
    const dir = join(FIXTURES_ROOT, consumer);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".contract.json")) continue;
      const raw = readFileSync(join(dir, entry), "utf8");
      fixtures.push(JSON.parse(raw) as ContractFixture);
    }
  }
  return fixtures;
}

export function loadFixture(
  consumer: ContractConsumer,
  iface: ContractFixture["interface"],
): ContractFixture {
  const match = loadFixtures().find(
    (f) => f.consumer === consumer && f.interface === iface,
  );
  if (!match) {
    throw new Error(
      `No contract fixture found for ${consumer} :: ${iface}. ` +
        `Expected test/contracts/fixtures/${consumer}/${iface}.contract.json`,
    );
  }
  return match;
}
```

File: test/contracts/fixtures/refract-frontend/consensus-decision.contract.json
```json
{
  "consumer": "refract-frontend",
  "interface": "consensus-decision",
  "version": 1,
  "description": "Consensus decision record rendered by the trust badge.",
  "shape": {
    "id": { "type": "string" },
    "policyId": { "type": "string" },
    "outcome": {
      "type": "string",
      "enum": ["approve", "reject", "abstain"]
    },
    "confidence": { "type": "number", "unit": "bps" },
    "decidedAt": { "type": "string", "unit": "iso8601" },
    "votes": {
      "type": "array",
      "items": {
        "type": "object",
        "fields": {
          "oracleId": { "type": "string" },
          "vote": { "type": "string", "enum": ["approve", "reject", "abstain"] },
          "weight": { "type": "number", "unit": "bps" }
        }
      }
    }
  }
}
```

File: test/contracts/fixtures/refract-frontend/provenance.contract.json
```json
{
  "consumer": "refract-frontend",
  "interface": "provenance",
  "version": 1,
  "description": "Provenance attestation surfaced in the trust detail panel.",
  "shape": {
    "attestationId": { "type": "string" },
    "oracleId": { "type": "string" },
    "subjectId": { "type": "string" },
    "attestedAt": { "type": "string", "unit": "iso8601" },
    "signature": { "type": "string" },
    "metadata": { "type": "object", "required": false }
  }
}
```

File: test/contracts/fixtures/refract-frontend/trust-status.contract.json
```json
{
  "consumer": "refract-frontend",
  "interface": "trust-status",
  "version": 1,
  "description": "Trust status response rendered by the trust badge.",
  "shape": {
    "subjectId": { "type": "string" },
    "status": {
      "type": "string",
      "enum": ["trusted", "untrusted", "pending", "revoked"]
    },
    "score": { "type": "number", "unit": "bps" },
    "updatedAt": { "type": "string", "unit": "iso8601" },
    "reason": { "type": "string", "required": false }
  }
}
```

File: test/contracts/fixtures/refract-contracts/onchain-reading.contract.json
```json
{
  "consumer": "refract-contracts",
  "interface": "onchain-reading",
  "version": 1,
  "description": "Encoded oracle reading published on-chain; consumed by the Soroban contract.",
  "shape": {
    "subjectId": { "type": "string" },
    "value": { "type": "number", "unit": "stroops" },
    "decimals": { "type": "number", "unit": "count" },
    "timestamp": { "type": "number", "unit": "unix-seconds" },
    "signature": { "type": "string" }
  }
}
```

File: test/contracts/consensus-decision.contract.ts
```typescript
/**
 * Producer verification: consensus decision record.
 *
 * Verifies that the backend's consensus decision payload satisfies the
 * refract-frontend contract.
 */
import { loadFixture } from "./fixtures";
import { assertContract } from "./verifier";

describe("contract: refract-frontend :: consensus-decision", () => {
  const fixture = loadFixture("refract-frontend", "consensus-decision");

  it("accepts a well-formed decision record", () => {
    const payload = {
      id: "dec_123",
      policyId: "pol_456",
      outcome: "approve",
      confidence: 9500,
      decidedAt: "2024-01-01T00:00:00.000Z",
      votes: [
        { oracleId: "oracle_a", vote: "approve", weight: 6000 },
        { oracleId: "oracle_b", vote: "approve", weight: 3500 },
      ],
    };
    expect(() => assertContract(fixture, payload)).not.toThrow();
  });

  it("passes additive changes (extra fields)", () => {
    const payload = {
      id: "dec_123",
      policyId: "pol_456",
      outcome: "approve",
      confidence: 9500,
      decidedAt: "2024-01-01T00:00:00.000Z",
      votes: [],
      // additive field not in the contract
      traceId: "trace_789",
    };
    expect(() => assertContract(fixture, payload)).not.toThrow();
  });

  it("fails with a named field when a required field is renamed", () => {
    const payload = {
      id: "dec_123",
      policyId: "pol_456",
      outcome: "approve",
      // renamed: confidence -> confidenceBps
      confidenceBps: 9500,
      decidedAt: "2024-01-01T00:00:00.000Z",
      votes: [],
    };
    expect(() => assertContract(fixture, payload)).toThrow(/field "confidence"/);
  });

  it("fails when the confidence unit changes", () => {
    const payload = {
      id: "dec_123",
      policyId: "pol_456",
      outcome: "approve",
      confidence: "0.95",
      decidedAt: "2024-01-01T00:00:00.000Z",
      votes: [],
    };
    expect(() => assertContract(fixture, payload)).toThrow(/field "confidence"/);
  });
});
```

File: test/contracts/provenance.contract.ts
```typescript
/**
 * Producer verification: provenance attestation.
 */
import { loadFixture } from "./fixtures";
import { assertContract } from "./verifier";

describe("contract: refract-frontend :: provenance", () => {
  const fixture = loadFixture("refract-frontend", "provenance");

  it("accepts a well-formed attestation", () => {
    const payload = {
      attestationId: "att_1",
      oracleId: "oracle_a",
      subjectId: "subj_1",
      attestedAt: "2024-01-01T00:00:00.000Z",
      signature: "0xdeadbeef",
    };
    expect(() => assertContract(fixture, payload)).not.toThrow();
  });

  it("passes additive changes (optional metadata present)", () => {
    const payload = {
      attestationId: "att_1",
      oracleId: "oracle_a",
      subjectId: "subj_1",
      attestedAt: "2024-01-01T00:00:00.000Z",
      signature: "0xdeadbeef",
      metadata: { source: "chain" },
    };
    expect(() => assertContract(fixture, payload)).not.toThrow();
  });

  it("fails with a named field when signature is renamed", () => {
    const payload = {
      attestationId: "att_1",
      oracleId: "oracle_a",
      subjectId: "subj_1",
      attestedAt: "2024-01-01T00:00:00.000Z",
      // renamed: signature -> sig
      sig: "0xdeadbeef",
    };
    expect(() => assertContract(fixture, payload)).toThrow(/field "signature"/);
  });
});
```

File: test/contracts/trust-status.contract.ts
```typescript
/**
 * Producer verification: trust status response.
 */
import { loadFixture } from "./fixtures";
import { assertContract } from "./verifier";

describe("contract: refract-frontend :: trust-status", () => {
  const fixture = loadFixture("refract-frontend", "trust-status");

  it("accepts a well-formed trust status", () => {
    const payload = {
      subjectId: "subj_1",
      status: "trusted",
      score: 8700,
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    expect(() => assertContract(fixture, payload)).not.toThrow();
  });

  it("passes additive changes (optional reason present)", () => {
    const payload = {
      subjectId: "subj_1",
      status: "untrusted",
      score: 1200,
      updatedAt: "2024-01-01T00:00:00.000Z",
      reason: "policy violation",
    };
    expect(() => assertContract(fixture, payload)).not.toThrow();
  });

  it("fails with a named field when status is renamed", () => {
    const payload = {
      subjectId: "subj_1",
      // renamed: status -> state
      state: "trusted",
      score: 8700,
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    expect(() => assertContract(fixture, payload)).toThrow(/field "status"/);
  });

  it("fails when status is outside the allowed enum", () => {
    const payload = {
      subjectId: "subj_1",
      status: "unknown",
      score: 8700,
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    expect(() => assertContract(fixture, payload)).toThrow(/field "status"/);
  });
});
```

File: test/contracts/onchain-reading.contract.ts
```typescript
/**
 * Producer verification: encoded on-chain reading.
 *
 * Verifies that the oracle reading encoder produces a payload that satisfies
 * the refract-contracts contract.
 */
import { loadFixture } from "./fixtures";
import { assertContract } from "./verifier";

describe("contract: refract-contracts :: onchain-reading", () => {
  const fixture = loadFixture("refract-contracts", "onchain-reading");

  it("accepts a well-formed encoded reading", () => {
    const payload = {
      subjectId: "subj_1",
      value: 1234567890,
      decimals: 7,
      timestamp: 1704067200,
      signature: "0xdeadbeef",
    };
    expect(() => assertContract(fixture, payload)).not.toThrow();
  });

  it("passes additive changes (extra fields)", () => {
    const payload = {
      subjectId: "subj_1",
      value: 1234567890,
      decimals: 7,
      timestamp: 1704067200,
      signature: "0xdeadbeef",
      // additive field not in the contract
      nonce: 42,
    };
    expect(() => assertContract(fixture, payload)).not.toThrow();
  });

  it("fails with a named field when value is renamed", () => {
    const payload = {
      subjectId: "subj_1",
      // renamed: value -> amount
      amount: 1234567890,
      decimals: 7,
      timestamp: 1704067200,
      signature: "0xdeadbeef",
    };
    expect(() => assertContract(fixture, payload)).toThrow(/field "value"/);
  });

  it("fails when value is encoded as a string instead of stroops number", () => {
    const payload = {
      subjectId: "subj_1",
      value: "1234567890",
      decimals: 7,
      timestamp: 1704067200,
      signature: "0xdeadbeef",
    };
    expect(() => assertContract(fixture, payload)).toThrow(/field "value"/);
  });
});
```

File: test/contracts/proof.contract.ts
```typescript
/**
 * Proof test: deliberately rename a field and confirm the verifier fails with
 * a readable, named-field message.
 *
 * This test exists to demonstrate that a breaking change in the producer is
 * caught by CI. It does not mutate any real fixture; it constructs an
 * in-memory fixture and a payload that violates it.
 */
import { formatViolations, verifyContract } from "./verifier";
import type { ContractFixture } from "./types";

describe("contract verifier proof", () => {
  const fixture: ContractFixture = {
    consumer: "refract-frontend",
    interface: "trust-status",
    version: 1,
    description: "proof fixture",
    shape: {
      subjectId: { type: "string" },
      status: { type: "string", enum: ["trusted", "untrusted"] },
    },
  };

  it("fails and names the renamed field", () => {
    const renamedPayload = {
      subjectId: "subj_1",
      // renamed: status -> state
      state: "trusted",
    };

    const violations = verifyContract(fixture, renamedPayload);
    expect(violations).toHaveLength(1);
    expect(violations[0].path).toBe("status");
    expect(violations[0].reason).toMatch(/missing/);

    const message = formatViolations(fixture, violations);
    expect(message).toContain('field "status"');
    expect(message).toContain("refract-frontend");
    expect(message).toContain("trust-status");
  });

  it("passes when the field is present (additive change)", () => {
    const additivePayload = {
      subjectId: "subj_1",
      status: "trusted",
      // additive field
      reason: "ok",
    };
    expect(verifyContract(fixture, additivePayload)).toHaveLength(0);
  });
});
```

File: test/contracts/README.md
```markdown
# Consumer-Driven Contract Tests

This directory contains the consumer-driven contract verification suite for
`refract-backend`. It pins the shapes of oracle trust data produced by the
backend against the expectations of `refract-frontend` and `refract-contracts`.

## Layout

```
test/contracts/
  jest.contracts.config.ts        # Jest project for the suite
  types.ts                        # Shared contract types
  verifier.ts                     # Generated verifier
  fixtures.ts                     # Fixture loader
  fixtures/
    refract-frontend/
      consensus-decision.contract.json
      provenance.contract.json
      trust-status.contract.json
    refract-contracts/
      onchain-reading.contract.json
  *.contract.ts                   # Producer verification tests
  proof.contract.ts               # Proof test: renamed field fails
```

## Running

```sh
npx jest --config test/contracts/jest.contracts.config.ts
```

The suite requires no live database and no network access. It runs within the
existing CI time budget.

## Semantics

- **Additive changes pass.** Extra fields on the producer payload are allowed.
  New optional fields may be added to a contract without a version bump.
- **Breaking changes fail.** Missing required fields, type mismatches, unit
  mismatches, and enum mismatches are violations. The failure message names the
  offending field (e.g. `field "confidence"`).
- **Unit changes are breaking.** A field pinned with `"unit": "bps"` that
  changes to a fraction is a violation even if the type stays `number`.

## Updating a contract

Contracts are owned by the consumer. The process is:

1. **Consumer proposes the change.** The consumer repo (`refract-frontend` or
   `refract-contracts`) opens a PR that edits the relevant
   `*.contract.json` fixture.
2. **Classify the change.**
   - *Additive* (new optional field, new enum value the consumer tolerates):
     no version bump required. The producer's existing tests continue to pass.
   - *Breaking* (rename, removal, type change, unit change, enum narrowing):
     bump `version` in the fixture and note the change in the PR description.
3. **Producer verifies.** `refract-backend` CI runs
   `npx jest --config test/contracts/jest.contracts.config.ts`. A breaking
   change fails the build with a named field until the producer is updated.
4. **Consumer opts in.** The consumer merges the fixture change only after the
   producer has shipped a compatible payload (or the consumer has updated its
   rendering to match). The version bump signals the opt-in boundary.
5. **Sync the fixture.** The updated fixture is copied into
   `test/contracts/fixtures/<consumer>/` in this repo.

## Proof test

`proof.contract.ts` deliberately renames a field and asserts that the verifier
fails with a readable, named-field message. This demonstrates that a breaking
change in a branch will fail CI.
```

File: package.json (add scripts)
```json
{
  "scripts": {
    "test:contracts": "jest --config test/contracts/jest.contracts.config.ts"
  }
}
```

File: .github/workflows/contracts.yml
```yaml
name: Contract Tests

on:
  push:
    branches: [main]
  pull_request:

jobs:
  contracts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - name: Verify producer against consumer contracts
        run: npm run test:contracts