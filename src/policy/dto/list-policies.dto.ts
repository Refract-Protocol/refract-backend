import { Transform } from "class-transformer";
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from "class-validator";

/**
 * Query-parameter DTO for GET /api/v1/policies/holder/:address.
 *
 * All fields are optional so the endpoint stays backward-compatible with
 * callers that don't supply any params (they get page 1, 20 results,
 * all coverage types, both active and inactive, sorted by createdAt DESC).
 */
export class ListPoliciesDto {
  /** 1-based page number. */
  @IsOptional()
  @Transform(({ value }) => parseInt(value as string, 10))
  @IsInt()
  @Min(1)
  page: number = 1;

  /** Results per page — capped at 100 to prevent runaway payloads. */
  @IsOptional()
  @Transform(({ value }) => parseInt(value as string, 10))
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  /**
   * Filter by active status.
   * "true" / "false" strings are coerced to booleans by the transformer.
   * Omit to return both active and inactive policies.
   */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === "true") return true;
    if (value === "false") return false;
    return value as boolean;
  })
  @IsBoolean()
  isActive?: boolean;

  /**
   * Filter by coverage type index (0–4, matching PolicyService's enum).
   * Omit to return all coverage types.
   */
  @IsOptional()
  @Transform(({ value }) => parseInt(value as string, 10))
  @IsInt()
  @Min(0)
  @Max(4)
  coverageType?: number;

  /** Field to sort results by. */
  @IsOptional()
  @IsIn(["createdAt", "expiresAt", "coverageAmount", "premium"])
  sortBy: "createdAt" | "expiresAt" | "coverageAmount" | "premium" = "createdAt";

  /** Sort direction. */
  @IsOptional()
  @IsIn(["asc", "desc"])
  sortDir: "asc" | "desc" = "desc";
}
