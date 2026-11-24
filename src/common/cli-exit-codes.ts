/**
 * Shared exit code contract for the operator-facing CLIs (`scripts/operator-cli.ts`,
 * `scripts/oracle-ops.ts` / `src/oracle/consensus/cli.ts`). Keeping this in one module
 * is what makes the codes a stable contract instead of a per-script accident: a
 * wrapping script that branches on exit status needs to know it means the same
 * thing everywhere. Lives under `src/` (not `scripts/`) so `tsc`'s `rootDir: "src"`
 * build can still import it from `src/oracle/consensus/cli.ts`.
 */
export const EXIT_SUCCESS = 0;
export const EXIT_USAGE_ERROR = 1;
export const EXIT_REMOTE_ERROR = 2;

/** Thrown for a bad invocation (args/flags/missing confirmation) before anything remote is touched. */
export class CliUsageError extends Error {}
