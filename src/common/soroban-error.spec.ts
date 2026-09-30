import { decodeSorobanError } from "./soroban-error";

describe("decodeSorobanError", () => {
  it("maps known pool contract variants to stable error codes and readable messages", () => {
    expect(decodeSorobanError(new Error("HostError: PoolError::CapitalLocked"))).toEqual({
      code: "POOL_CAPITAL_LOCKED",
      error: "Pool capital is locked and cannot be withdrawn yet.",
    });
  });

  it("decodes named variants from structured submission diagnostics", () => {
    expect(
      decodeSorobanError({
        status: "ERROR",
        diagnosticEvents: [{ message: "ContractError: InsufficientCapacity" }],
      })
    ).toEqual({
      code: "POOL_INSUFFICIENT_CAPACITY",
      error: "The pool does not have enough available capacity for this operation.",
    });
  });

  it("does not expose unknown Soroban details to the caller", () => {
    expect(decodeSorobanError(new Error("RPC endpoint https://internal.invalid failed"))).toEqual({
      code: "SOROBAN_REQUEST_FAILED",
      error: "The Soroban request failed. Please retry later or contact support.",
    });
  });
});
