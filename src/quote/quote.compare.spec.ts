import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { CoverageTypeName } from "./coverage-type";
import { QuoteModule } from "./quote.module";
import { QuoteService } from "./quote.service";

describe("QuoteService.compareQuotes", () => {
  let service: QuoteService;

  beforeEach(() => {
    service = new QuoteService();
  });

  it("quotes every coverage type in catalog order when no subset is given", () => {
    const comparison = service.compareQuotes({ coverageAmount: 10_000, durationDays: 1 });

    expect(comparison.results.map((r) => r.coverageType)).toEqual(Object.values(CoverageTypeName));
    expect(comparison.results.every((r) => r.status === "quoted")).toBe(true);
    expect(comparison).toMatchObject({ coverageAmount: 10_000, durationDays: 1 });
  });

  it("returns the same premium as a single createQuote for each type", () => {
    const comparison = service.compareQuotes({ coverageAmount: 25_000, durationDays: 30 });

    for (const entry of comparison.results) {
      if (entry.status !== "quoted") continue;
      const single = service.createQuote({ coverageType: entry.coverageType, coverageAmount: 25_000, durationDays: 30 });
      expect(entry.quote.premium).toBe(single.premium);
      expect(entry.quote.triggerThreshold).toBe(single.triggerThreshold);
    }
  });

  it("mixes accepted and rejected types in one response instead of failing the batch", () => {
    // 60 days: within StablecoinDepeg (365), MarketCrash (90), SmartContractRisk
    // (180); beyond LiquidationShield (30) and FlightDelay (1).
    const { results } = service.compareQuotes({ coverageAmount: 10_000, durationDays: 60 });

    const status = Object.fromEntries(results.map((r) => [r.coverageType, r.status]));
    expect(status).toEqual({
      [CoverageTypeName.StablecoinDepeg]: "quoted",
      [CoverageTypeName.MarketCrash]: "quoted",
      [CoverageTypeName.LiquidationShield]: "rejected",
      [CoverageTypeName.SmartContractRisk]: "quoted",
      [CoverageTypeName.FlightDelay]: "rejected",
    });

    const flight = results.find((r) => r.coverageType === CoverageTypeName.FlightDelay);
    expect(flight).toEqual({
      coverageType: CoverageTypeName.FlightDelay,
      status: "rejected",
      error: "Flight Delay coverage is limited to 1 day(s)",
      maxDuration: 1,
    });
  });

  it("limits results to the requested subset, in catalog order", () => {
    const { results } = service.compareQuotes({
      coverageAmount: 5_000,
      durationDays: 7,
      coverageTypes: [CoverageTypeName.SmartContractRisk, CoverageTypeName.StablecoinDepeg],
    });

    expect(results.map((r) => r.coverageType)).toEqual([
      CoverageTypeName.StablecoinDepeg,
      CoverageTypeName.SmartContractRisk,
    ]);
  });

  it("rethrows unexpected errors rather than reporting them as rejections", () => {
    jest.spyOn(service, "createQuote").mockImplementation(() => {
      throw new Error("boom");
    });

    expect(() => service.compareQuotes({ coverageAmount: 1_000, durationDays: 1 })).toThrow("boom");
  });
});

describe("POST /api/v1/quotes/compare", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [QuoteModule] }).compile();
    app = moduleRef.createNestApplication();
    // Mirrors main.ts's global pipe.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns a comparison for a valid request", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/v1/quotes/compare")
      .send({ coverageAmount: 10_000, durationDays: 60 });

    expect(res.status).toBe(201);
    expect(res.body.results).toHaveLength(5);
    expect(res.body.results.filter((r: { status: string }) => r.status === "rejected")).toHaveLength(2);
  });

  it.each([
    ["an unknown coverage type", { coverageAmount: 1_000, durationDays: 1, coverageTypes: ["Nope"] }],
    ["an empty subset", { coverageAmount: 1_000, durationDays: 1, coverageTypes: [] }],
    [
      "a duplicated coverage type",
      { coverageAmount: 1_000, durationDays: 1, coverageTypes: ["FlightDelay", "FlightDelay"] },
    ],
    ["an out-of-range amount", { coverageAmount: 5, durationDays: 1 }],
    ["an out-of-range duration", { coverageAmount: 1_000, durationDays: 366 }],
    ["a triggerThreshold (not accepted across types)", { coverageAmount: 1_000, durationDays: 1, triggerThreshold: 500 }],
  ])("rejects %s with 400", async (_label, body) => {
    const res = await request(app.getHttpServer()).post("/api/v1/quotes/compare").send(body);

    expect(res.status).toBe(400);
  });
});
