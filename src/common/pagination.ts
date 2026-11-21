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

/** `?offset=&limit=` accepted by offset-paginated list endpoints. */
export interface OffsetPageQuery {
  offset?: number;
  limit?: number;
}

/** Page metadata returned alongside the items of an offset-paginated list. */
export interface OffsetPageMeta {
  offset: number;
  limit: number;
  /**
   * 0-based page index derived from the offset: `Math.floor(offset / limit)`.
   * Never mix this with page-number semantics — the rows served are always
   * `[offset, offset + limit)`, so an unaligned offset (15 with limit 10)
   * still lands on page 1 (0-based) while serving rows 15..24.
   */
  page: number;
  /** 1-based page number, for display and next/prev links. */
  pageNumber: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
  hasPrev: boolean;
  /** Offset to request the next page, or null on the last page. */
  nextOffset: number | null;
  /** Offset to request the previous page, or null on the first page. */
  prevOffset: number | null;
}

export interface OffsetPage<T> {
  items: T[];
  page: OffsetPageMeta;
}

function assertPageParam(name: "offset" | "limit", value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new BadRequestException({ error: `Invalid pagination ${name}: must be an integer >= ${min}` });
  }
}

/**
 * Offset-paginates `rows` in their given order. The page index is derived
 * with `Math.floor(offset / limit)` and the rows are sliced from the raw
 * `offset` — the two must never be conflated (e.g. by feeding a page number
 * back in as an offset), or unaligned offsets skip/duplicate rows.
 */
export function paginateOffset<T>(
  rows: readonly T[],
  query: OffsetPageQuery = {},
  defaultLimit: number = 20,
  maxLimit: number = MAX_PAGE_LIMIT,
): OffsetPage<T> {
  const offset = query.offset ?? 0;
  const rawLimit = query.limit ?? defaultLimit;
  assertPageParam("offset", offset, 0);
  assertPageParam("limit", rawLimit, 1);
  const limit = Math.min(rawLimit, Math.max(1, maxLimit));

  const total = rows.length;
  const page = Math.floor(offset / limit);
  const items = rows.slice(offset, offset + limit);
  const hasMore = offset + limit < total;
  const hasPrev = offset > 0;

  return {
    items,
    page: {
      offset,
      limit,
      page,
      pageNumber: page + 1,
      total,
      totalPages: Math.ceil(total / limit),
      hasMore,
      hasPrev,
      nextOffset: hasMore ? offset + limit : null,
      prevOffset: hasPrev ? Math.max(0, offset - limit) : null,
    },
  };
}
