import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { OpsAuthGuard } from "../../common/guards/ops-auth.guard";
import { OpsReevaluationController, REEVALUATION_EXECUTOR } from "./ops-reevaluation.controller";
import { ReevaluationItem } from "./reevaluation-planner";
import { ReevaluationRun, ReevaluationService } from "./reevaluation.service";

/**
 * Regression tests for #495: the offset-paginated run-items endpoint must
 * serve exactly the rows [offset, offset + limit) and derive the page number
 * with Math.floor(offset / limit), even when the offset is not a multiple of
 * the limit.
 */
describe("OpsReevaluationController offset pagination", () => {
  let app: INestApplication;

  const item = (i: number): ReevaluationItem => ({
    recordId: `rec-${String(i).padStart(2, "0")}`,
    policyId: `p${i}`,
    holder: "GALICE",
    coverageType: 0,
    before: "held",
    trustStateAtDecision: "degraded",
    after: "triggered",
    action: "settle",
    changed: i % 2 === 0, // even indices changed
    payoutDelta: "1",
    evidence: {
      windowStart: 0,
      windowEnd: 1,
      readingsUsed: 1,
      provenance: ["quorum"],
      decisionReading: 0.9,
      threshold: 0.95,
      triggerConfirmedAt: 1,
      reason: "test fixture",
    },
  });

  const run: ReevaluationRun = {
    runId: "run-1",
    feedId: "usdc-usd",
    degradedSince: 0,
    restoredAt: 1,
    items: Array.from({ length: 25 }, (_, i) => item(i)),
    summary: {
      settle: 25,
      release: 0,
      flag_overpayment: 0,
      no_change: 0,
      manual_review: 0,
      superseded: 0,
      affected: 25,
      changed: 13,
      netPayoutDelta: "25",
    },
    status: "planned",
    createdAt: 1,
    itemStatus: Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`rec-${String(i).padStart(2, "0")}`, { status: "pending" as const }]),
    ),
    audit: [],
  };

  const recIds = (body: { items: Array<{ recordId: string }> }): string[] => body.items.map((i) => i.recordId);
  const range = (from: number, to: number): string[] =>
    Array.from({ length: to - from }, (_, k) => `rec-${String(from + k).padStart(2, "0")}`);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OpsReevaluationController],
      providers: [
        {
          provide: ReevaluationService,
          useValue: { getRun: (id: string) => (id === "run-1" ? run : undefined) },
        },
        { provide: REEVALUATION_EXECUTOR, useValue: {} },
      ],
    })
      .overrideGuard(OpsAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (query: Record<string, string | number> = {}) =>
    request(app.getHttpServer()).get("/api/v1/ops/reevaluations/run-1").query(query);

  it("serves rows 15..24 (not the offset-10 page) for offset=15 & limit=10", async () => {
    const res = await get({ offset: 15, limit: 10 });

    expect(res.status).toBe(200);
    expect(recIds(res.body)).toEqual(range(15, 25));
    expect(res.body.page).toEqual({
      offset: 15,
      limit: 10,
      page: 1, // Math.floor(15 / 10)
      pageNumber: 2,
      total: 25,
      totalPages: 3,
      hasMore: false,
      hasPrev: true,
      nextOffset: null,
      prevOffset: 5,
    });
    expect(res.body.itemStatus).toBeUndefined();
  });

  it.each([
    [{ offset: 0, limit: 10 }, range(0, 10), { page: 0, pageNumber: 1, hasMore: true, nextOffset: 10, prevOffset: null }],
    [{ offset: 10, limit: 10 }, range(10, 20), { page: 1, pageNumber: 2, hasMore: true, nextOffset: 20, prevOffset: 0 }],
    [{ offset: 15, limit: 10 }, range(15, 25), { page: 1, pageNumber: 2, hasMore: false, nextOffset: null, prevOffset: 5 }],
    [{ offset: 20, limit: 10 }, range(20, 25), { page: 2, pageNumber: 3, hasMore: false, nextOffset: null, prevOffset: 10 }],
    [{ offset: 25, limit: 10 }, [], { page: 2, pageNumber: 3, hasMore: false, nextOffset: null, prevOffset: 15 }],
    [{ offset: 100, limit: 10 }, [], { page: 10, pageNumber: 11, hasMore: false, nextOffset: null, prevOffset: 90 }],
    [{ offset: 5, limit: 10 }, range(5, 15), { page: 0, pageNumber: 1, hasMore: true, nextOffset: 15, prevOffset: 0 }],
    [{ offset: 24, limit: 1 }, range(24, 25), { page: 24, pageNumber: 25, hasMore: false, nextOffset: null, prevOffset: 23 }],
  ])("offset=%j&limit=%j returns the right rows and page metadata", async (query, expectedIds, meta) => {
    const res = await get(query as Record<string, number>);

    expect(res.status).toBe(200);
    expect(recIds(res.body)).toEqual(expectedIds);
    expect(res.body.page).toMatchObject({ offset: (query as any).offset, limit: (query as any).limit, total: 25, ...meta });
  });

  it("defaults to limit=100 and serves every item on the first page", async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(recIds(res.body)).toEqual(range(0, 25));
    expect(res.body.page).toMatchObject({ offset: 0, limit: 100, page: 0, pageNumber: 1, total: 25, hasMore: false });
  });

  it("clamps an oversized limit to the maximum page size", async () => {
    const res = await get({ offset: 0, limit: 501 });

    expect(res.status).toBe(200);
    expect(res.body.page.limit).toBe(500);
    expect(recIds(res.body)).toEqual(range(0, 25));
  });

  it("paginates the changedOnly filter with unaligned offsets", async () => {
    // changed items are the even indices 0,2,...,24 (13 items); offset=5&limit=3
    // selects filtered[5..7] = original indices 10,12,14.
    const res = await get({ changedOnly: "true", offset: 5, limit: 3 });

    expect(res.status).toBe(200);
    expect(recIds(res.body)).toEqual(["rec-10", "rec-12", "rec-14"]);
    expect(res.body.page).toMatchObject({
      offset: 5,
      limit: 3,
      page: Math.floor(5 / 3),
      pageNumber: Math.floor(5 / 3) + 1,
      total: 13,
      hasMore: true,
      nextOffset: 8,
    });
  });

  it("walking nextOffset serves every item exactly once (no duplicates or gaps)", async () => {
    const seen: string[] = [];
    let query: Record<string, number> = { limit: 7 };
    for (let guard = 0; guard < 30; guard++) {
      const res = await get(query);
      expect(res.status).toBe(200);
      seen.push(...recIds(res.body));
      if (res.body.page.nextOffset === null) break;
      query = { offset: res.body.page.nextOffset, limit: 7 };
    }

    expect(seen).toEqual(range(0, 25));
  });

  it.each([
    [{ offset: 0, limit: 0 }, "limit=0"],
    [{ offset: -1, limit: 10 }, "negative offset"],
    [{ offset: "abc", limit: 10 }, "non-numeric offset"],
    [{ offset: 0, limit: "xyz" }, "non-numeric limit"],
    [{ offset: 2.5, limit: 10 }, "non-integer offset"],
  ])("rejects %j (%s) with 400", async (query) => {
    const res = await get(query as Record<string, string>);

    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown run", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/ops/reevaluations/nope");

    expect(res.status).toBe(404);
  });
});
