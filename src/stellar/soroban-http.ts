import {
  BadRequestException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  SorobanContractError,
  SorobanNotFoundError,
  SorobanRateLimitError,
  SorobanRestoreFeeExceededError,
  SorobanRestoreRequiredError,
  SorobanTransientError,
} from "./soroban-errors";

/**
 * Maps the Soroban error hierarchy to Nest HTTP exceptions so RPC failures
 * no longer collapse into a generic 400 BadRequestException.
 */
export function mapSorobanErrorToHttp(err: unknown, genericPrefix: string): never {
  if (err instanceof SorobanRestoreRequiredError) {
    throw new BadRequestException({
      error: "RESTORE_REQUIRED",
      message: err.message,
      restoreXdr: err.restoreXdr,
      estimatedFee: err.estimatedFee,
    });
  }
  if (err instanceof SorobanRestoreFeeExceededError) {
    throw new BadRequestException({
      error: "RESTORE_FEE_EXCEEDED",
      message: err.message,
      estimatedFee: err.estimatedFee,
      feeCeiling: err.feeCeiling,
    });
  }
  if (err instanceof SorobanRateLimitError) {
    throw new HttpException(
      {
        error: err.message,
        ...(err.retryAfterSeconds !== undefined ? { retryAfter: err.retryAfterSeconds } : {}),
      },
      HttpStatus.TOO_MANY_REQUESTS
    );
  }
  if (err instanceof SorobanTransientError) {
    throw new ServiceUnavailableException({ error: `${genericPrefix}: ${err.message}` });
  }
  if (err instanceof SorobanNotFoundError) {
    throw new HttpException({ error: err.message }, HttpStatus.NOT_FOUND);
  }
  if (err instanceof SorobanContractError) {
    throw new BadRequestException({ error: `${genericPrefix}: ${err.message}` });
  }
  const message = err instanceof Error ? err.message : String(err);
  throw new BadRequestException({ error: `${genericPrefix}: ${message}` });
}
