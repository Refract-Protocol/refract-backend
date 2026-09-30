import { Transform } from "class-transformer";
import { IsIn, IsInt, IsOptional, Max, Min } from "class-validator";

/**
 * Query-parameter DTO for GET /api/v1/claims/holder/:address
 * and GET /api/v1/claims/recent.
 */
export class ListClaimsDto {
  /** 1-based page number. */
  @IsOptional()
  @Transform(({ value }) => parseInt(value as string, 10))
  @IsInt()
  @Min(1)
  page: number = 1;

  /**
   * Results per page.
   * For /recent the default is 10 (matching the previous hard-coded value);
   * for /holder/:address the default is 20.
   */
  @IsOptional()
  @Transform(({ value }) => parseInt(value as string, 10))
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  /** Sort direction — always by processedAt. */
  @IsOptional()
  @IsIn(["asc", "desc"])
  sortDir: "asc" | "desc" = "desc";
}
