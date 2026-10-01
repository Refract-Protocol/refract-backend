export interface SorobanErrorResponse {
  code: string;
  error: string;
}

const POOL_ERROR_MESSAGES: Record<string, SorobanErrorResponse> = {
  InsufficientCapacity: {
    code: "POOL_INSUFFICIENT_CAPACITY",
    error: "The pool does not have enough available capacity for this operation.",
  },
  CapitalLocked: {
    code: "POOL_CAPITAL_LOCKED",
    error: "Pool capital is locked and cannot be withdrawn yet.",
  },
};

const UNKNOWN_SOROBAN_ERROR: SorobanErrorResponse = {
  code: "SOROBAN_REQUEST_FAILED",
  error: "The Soroban request failed. Please retry later or contact support.",
};

export function decodeSorobanError(error: unknown): SorobanErrorResponse {
  let rawMessage: string;
  if (error instanceof Error) {
    rawMessage = error.message;
  } else if (typeof error === "string") {
    rawMessage = error;
  } else {
    try {
      rawMessage = JSON.stringify(error);
    } catch {
      rawMessage = String(error);
    }
  }

  for (const [variant, response] of Object.entries(POOL_ERROR_MESSAGES)) {
    if (new RegExp(`\\b${variant}\\b`, "i").test(rawMessage)) {
      return response;
    }
  }
  return UNKNOWN_SOROBAN_ERROR;
}
