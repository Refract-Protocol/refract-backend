import type { Config } from "jest";

/**
 * Separate Jest project for integration tests that spin up a real,
 * ephemeral Postgres instance via testcontainers.
 *
 * Run:  npx jest --config test/integration/jest.integration.config.ts
 *
 * The suite is intentionally kept out of the default `jest` (rootDir:src)
 * run so unit tests stay fast and free of Docker dependency.
 *
 * Note: the global setup applies the full schema, including the
 * reference-data registry migration (see `src/db/migrations/`), so
 * integration tests for reference-data validation run against the
 * same schema as production. The `*.ispec.ts` glob below already
 * matches the reference-data integration tests (e.g.
 * `test/integration/referenceData.ispec.ts`).
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