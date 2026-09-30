/**
 * Raised when the persisted indexer cursor ledger is older than the RPC
 * node's event retention window (`oldestLedger`). Callers must not silently
 * skip — operators need to re-backfill from a ledger still retained by the RPC.
 */
export class CursorOutsideRetentionWindowError extends Error {
  readonly code = "CURSOR_OUTSIDE_RETENTION_WINDOW" as const;

  constructor(
    public readonly cursorLedger: number,
    public readonly oldestLedger: number,
    public readonly latestLedger: number
  ) {
    super(
      `Indexer cursor ledger ${cursorLedger} is outside the Soroban RPC retention window ` +
        `(oldestLedger=${oldestLedger}, latestLedger=${latestLedger}). ` +
        `Re-backfill from a ledger >= ${oldestLedger}; do not silently skip.`
    );
    this.name = "CursorOutsideRetentionWindowError";
  }
}
