import { BadRequestException } from "@nestjs/common";
import { QuoteService } from "./quote.service";
import { CoverageTypeName } from "./coverage-type";
import { CreateQuoteDto } from "./dto/create-quote.dto";

function buildDto(overrides: Partial<CreateQuoteDto> = {}): CreateQuoteDto {
  return {
    coverageType: CoverageTypeName.StablecoinDepeg,
    coverageAmount: 10_000,
    durationDays: 30,
    ...overrides,
  };
}

describe("QuoteService", () => {
  let service: QuoteService;

  beforeEach(() => {
    service = new QuoteService();
  });

  describe("listCoverageTypes", () => {
    it("returns all five coverage types", () => {
      expect(service.listCoverageTypes()).toHaveLength(5);
    });
  });

  describe("createQuote", () => {
    it("computes premium from coverageAmount, risk multiplier, and duration", () => {
      const quote = service.createQuote(buildDto({ coverageAmount: 10_000, durationDays: 365 }));

      // StablecoinDepeg: 3% base rate * 1.0 multiplier over a full year.
      expect(quote.premium).toBeCloseTo(300, 1);
    });

    it("defaults triggerThreshold from the coverage type when none is supplied", () => {
      const quote = service.createQuote(buildDto({ coverageType: CoverageTypeName.MarketCrash, triggerThreshold: undefined }));
      expect(quote.triggerThreshold).toBe(3000);
    });

    it("uses a caller-supplied triggerThreshold when given", () => {
      const quote = service.createQuote(buildDto({ triggerThreshold: 750 }));
      expect(quote.triggerThreshold).toBe(750);
    });

    it("allows a duration exactly at the coverage type's maxDuration", () => {
      // Flight Delay's catalog entry advertises maxDuration: 1.
      expect(() =>
        service.createQuote(buildDto({ coverageType: CoverageTypeName.FlightDelay, durationDays: 1 }))
      ).not.toThrow();
    });

    it("rejects a duration beyond the coverage type's advertised maxDuration", () => {
      // Flight Delay's catalog entry advertises maxDuration: 1, but nothing
      // stopped a caller from requesting e.g. a 30-day quote before this fix.
      expect.assertions(2);
      try {
        service.createQuote(buildDto({ coverageType: CoverageTypeName.FlightDelay, durationDays: 30 }));
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const response = (err as BadRequestException).getResponse() as { maxDuration: number };
        expect(response.maxDuration).toBe(1);
      }
    });

    it("rejects Market Crash quotes beyond its 90-day maxDuration", () => {
      expect(() =>
        service.createQuote(buildDto({ coverageType: CoverageTypeName.MarketCrash, durationDays: 91 }))
      ).toThrow(BadRequestException);
    });
  });
});
