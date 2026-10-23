import { Body, Controller, Get, Header, Post } from "@nestjs/common";
import { STATIC_RESOURCE_CACHE_CONTROL } from "../common/http-cache";
import { CompareQuotesDto } from "./dto/compare-quotes.dto";
import { CreateQuoteDto } from "./dto/create-quote.dto";
import { CoverageTypeInfo, QuoteComparison, QuoteResult, QuoteService } from "./quote.service";

@Controller({ path: "quotes", version: "1" })
export class QuoteController {
  constructor(private readonly quoteService: QuoteService) {}

  /** POST /api/v1/quotes — calculate a premium quote */
  @Post()
  createQuote(@Body() dto: CreateQuoteDto): QuoteResult {
    return this.quoteService.createQuote(dto);
  }

  /** POST /api/v1/quotes/compare — quote one amount/duration across coverage types */
  @Post("compare")
  compareQuotes(@Body() dto: CompareQuotesDto): QuoteComparison {
    return this.quoteService.compareQuotes(dto);
  }

  /** GET /api/v1/quotes/coverage-types — list available coverage with descriptions */
  @Get("coverage-types")
  @Header("Cache-Control", STATIC_RESOURCE_CACHE_CONTROL)
  listCoverageTypes(): { types: CoverageTypeInfo[] } {
    return { types: this.quoteService.listCoverageTypes() };
  }
}
