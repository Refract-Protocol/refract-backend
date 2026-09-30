import { BadRequestException, INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { ClaimController } from "../claim/claim.controller";
import { ClaimResult } from "../claim/claim-result";
import { ClaimService } from "../claim/claim.service";
import { PolicyController } from "../policy/policy.controller";
import { PolicyService, StoredPolicy } from "../policy/policy.service";
import { PageKey, decodeCursor, encodeCursor, paginateDesc } from "./pagination";

interface Row {
  id: string;
  at: number;
}

const keyOf = (r: Row): PageKey => ({ at: r.at, id: r.id });
const ids = (rows: Row[]): string[] => rows.map((r) => r.id);

/** Follows nextCursor until exhausted, returning every page's ids. */
function walk(rows: Row[], limit: number): string[][] {
  const pages: string[][] = [];
  let cursor: string | undefined;
  do {
    const page = paginateDesc(rows, keyOf, { limit, cursor }, 50);
    pages.push(ids(page.items));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return pages;
}

describe("paginateDesc", () => {
  const rows: Row[] = [
    { id: "a", at: 1_000 },
    { id: "b", at: 3_000 },
    { id: "c", at: 2_000 },
    { id: "d", at: 3_000 }, // ties with "b" on timestamp
    { id: "e", at: 5_000 },
  ];

  it("returns a default-sized, newest-first first page when no params are given", () => {
    const page = paginateDesc(rows, keyOf, {}, 3);

    expect(ids(page.items)).toEqual(["e", "d", "b"]);
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  it("returns every row exactly once across pages, breaking timestamp ties by id", () => {
    expect(walk(rows, 2)).toEqual([["e", "d"], ["b", "c"], ["a"]]);
  });

  it("returns a null nextCursor when the last page is exactly full", () => {
    const page = paginateDesc(rows, keyOf, { limit: 5 }, 50);

    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
  });

  it("stays stable when newer rows are inserted between page requests", () => {
    const live = [...rows];
    const first = paginateDesc(live, keyOf, { limit: 2 }, 50);

    // Offset pagination would now repeat "d" on page 2.
    live.push({ id: "f", at: 9_000 }, { id: "g", at: 9_500 });
    const second = paginateDesc(live, keyOf, { limit: 2, cursor: first.nextCursor! }, 50);
    const third = paginateDesc(live, keyOf, { limit: 2, cursor: second.nextCursor! }, 50);

    expect([...ids(first.items), ...ids(second.items), ...ids(third.items)]).toEqual(["e", "d", "b", "c", "a"]);
    expect(third.nextCursor).toBeNull();
  });

  it("returns an empty last page for an empty collection", () => {
    expect(paginateDesc([], keyOf, {}, 10)).toEqual({ items: [], nextCursor: null });
  });

  it("does not mutate the input", () => {
    const input = [...rows];
    paginateDesc(input, keyOf, { limit: 2 }, 50);
    expect(input).toEqual(rows);
  });
});

describe("cursor encoding", () => {
  it("round-trips a key", () => {
    expect(decodeCursor(encodeCursor({ at: 1_700_000_000_000, id: "abc" }))).toEqual({
      at: 1_700_000_000_000,
      id: "abc",
    });
  });

  it.each([
    ["not base64 JSON", "%%%"],
    ["valid JSON of the wrong shape", Buffer.from('{"at":1}').toString("base64url")],
    ["a non-numeric timestamp", Buffer.from('["x","id"]').toString("base64url")],
  ])("rejects %s with a 400", (_label, cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(BadRequestException);
  });
});

describe("paginated list endpoints", () => {
  let app: INestApplication;

  const policy = (id: string, createdAt: string): StoredPolicy => ({
    id,
    holder: "GALICE",
    coverageType: 0,
    coverageTypeName: "Stablecoin Depeg",
    coverageAmount: "1",
    premium: "1",
    durationDays: 1,
    expiresAt: 0,
    isActive: true,
    createdAt,
  });
  const claim = (policyId: string, processedAt: number): ClaimResult => ({
    policyId,
    holder: "GALICE",
    coverageType: 0,
    triggered: true,
    payout: "1",
    reason: "r",
    processedAt,
  });

  const policies = [
    policy("p1", "2026-01-01T00:00:00.000Z"),
    policy("p2", "2026-01-03T00:00:00.000Z"),
    policy("p3", "2026-01-02T00:00:00.000Z"),
  ];
  const claims = Array.from({ length: 12 }, (_, i) => claim(`c${String(i).padStart(2, "0")}`, 1_000 + i));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PolicyController, ClaimController],
      providers: [
        { provide: PolicyService, useValue: { findByHolder: () => policies } },
        {
          provide: ClaimService,
          useValue: { getHistoryForHolder: () => claims, getRecentSettlements: () => claims },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // Mirrors main.ts's global pipe.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("keeps the existing `policies` key and adds nextCursor", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/policies/holder/GALICE?limit=2");

    expect(res.status).toBe(200);
    expect(res.body.policies.map((p: StoredPolicy) => p.id)).toEqual(["p2", "p3"]);

    const next = await request(app.getHttpServer())
      .get("/api/v1/policies/holder/GALICE")
      .query({ limit: 2, cursor: res.body.nextCursor });
    expect(next.body).toEqual({ policies: [expect.objectContaining({ id: "p1" })], nextCursor: null });
  });

  it("returns the first 10 claims from /recent by default, as before pagination", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/claims/recent");

    expect(res.status).toBe(200);
    expect(res.body.claims).toHaveLength(10);
    expect(res.body.claims[0].policyId).toBe("c11");
    expect(res.body.nextCursor).toEqual(expect.any(String));
  });

  it("returns a holder's full short history on the default first page", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/claims/holder/GALICE");

    expect(res.body.claims).toHaveLength(12);
    expect(res.body.nextCursor).toBeNull();
  });

  it.each([
    ["limit=0", "/api/v1/claims/recent?limit=0"],
    ["limit=101", "/api/v1/claims/recent?limit=101"],
    ["limit=abc", "/api/v1/claims/recent?limit=abc"],
    ["a malformed cursor", "/api/v1/claims/holder/GALICE?cursor=nope"],
    ["an unknown query param", "/api/v1/policies/holder/GALICE?offset=10"],
  ])("rejects %s with 400", async (_label, url) => {
    const res = await request(app.getHttpServer()).get(url);

    expect(res.status).toBe(400);
  });
});
