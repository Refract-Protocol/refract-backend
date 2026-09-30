import { BadRequestException } from "@nestjs/common";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";

export const MAX_PAGE_LIMIT = 100;

/** `?limit=&cursor=` accepted by every paginated list endpoint. */
export class PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_LIMIT)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;
}

/**
 * Keyset position of a row: its sort timestamp (ms) plus a unique id as
 * the tie-breaker. Mirrors the `(created_at, id)` / `(processed_at, id)`
 * keysets the Postgres repositories will page on.
 */
export interface PageKey {
  at: number;
  id: string;
}

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page, or null on the last page. */
  nextCursor: string | null;
}

export function encodeCursor(key: PageKey): string {
  return Buffer.from(JSON.stringify([key.at, key.id])).toString("base64url");
}

export function decodeCursor(cursor: string): PageKey {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(decoded) &&
      decoded.length === 2 &&
      Number.isFinite(decoded[0]) &&
      typeof decoded[1] === "string"
    ) {
      return { at: decoded[0], id: decoded[1] };
    }
  } catch {
    // fall through to the 400 below
  }
  throw new BadRequestException({ error: "Invalid pagination cursor" });
}

/** Newest first; equal timestamps order by id descending. */
function compareDesc(a: PageKey, b: PageKey): number {
  if (a.at !== b.at) return b.at - a.at;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Keyset-paginates `rows` newest first. A page after `cursor` holds only
 * rows strictly older than the cursor's key, so rows inserted between
 * requests (always newer) can't shift later pages into duplicates or
 * gaps — unlike offset pagination.
 */
export function paginateDesc<T>(
  rows: readonly T[],
  keyOf: (row: T) => PageKey,
  query: PageQueryDto,
  defaultLimit: number
): Page<T> {
  const limit = query.limit ?? defaultLimit;
  const after = query.cursor !== undefined ? decodeCursor(query.cursor) : undefined;

  const sorted = [...rows].sort((a, b) => compareDesc(keyOf(a), keyOf(b)));
  const remaining = after ? sorted.filter((row) => compareDesc(after, keyOf(row)) < 0) : sorted;
  const items = remaining.slice(0, limit);
  const hasMore = remaining.length > limit;

  return {
    items,
    nextCursor: hasMore ? encodeCursor(keyOf(items[items.length - 1])) : null,
  };
}
