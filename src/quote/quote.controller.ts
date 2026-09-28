import { Body, Controller, Get, Header, Post } from "@nestjs/common";
import { STATIC_RESOURCE_CACHE_CONTROL } from "../common/http-cache";
import { CreateQuoteDto } from "./dto/create-quote.dto";
import { CoverageTypeInfo, QuoteResult, QuoteService } from "./quote.service";

@Controller("api/v1/quotes")
export class QuoteController {
  constructor(private readonly quoteService: QuoteService) {}

  /** POST /api/v1/quotes — calculate a premium quote */
  @Post()
  createQuote(@Body() dto: CreateQuoteDto): QuoteResult {
    return this.quoteService.createQuote(dto);
  }

  /** GET /api/v1/quotes/coverage-types — list available coverage with descriptions */
  @Get("coverage-types")
  @Header("Cache-Control", STATIC_RESOURCE_CACHE_CONTROL)
  listCoverageTypes(): { types: CoverageTypeInfo[] } {
    return { types: this.quoteService.listCoverageTypes() };
  }
}
