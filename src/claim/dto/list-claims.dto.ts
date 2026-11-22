import { Transform } from "class-transformer";
import { IsIn, IsInt, IsOptional, Max, Min } from "class-validator";

/**
 * Query-parameter DTO for GET /api/v1/claims/holder/:address
 * and GET /api/v1/claims/recent.
 *
 * Unknown query parameters are rejected (400 naming the offending
 * parameter, e.g. `limt=10`) by the `ValidationPipe` applied on the
 * controller with `forbidNonWhitelisted: true`. This is deliberate: a
 * silently ignored typo would return a default-sized page and look like
 * a correct response. Callers that send harmless extras (cache-busters,
 * tracking params) must drop them; the accepted set is exactly the
 * properties declared below.
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
