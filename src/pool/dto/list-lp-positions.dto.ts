import { Type } from "class-transformer";
import { IsIn, IsInt, Max, Min } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class ListLpPositionsDto {
  @ApiProperty({ description: "1-based page number", minimum: 1, default: 1, required: false })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiProperty({ description: "Number of positions per page", minimum: 1, maximum: 100, default: 20, required: false })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @ApiProperty({ description: "Capital-committed sort direction", enum: ["asc", "desc"], default: "desc", required: false })
  @IsIn(["asc", "desc"])
  sortOrder: "asc" | "desc" = "desc";
}
