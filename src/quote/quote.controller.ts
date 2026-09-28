import { Body, Controller, Get, Post } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { CreateQuoteDto } from "./dto/create-quote.dto";
import { CoverageTypeInfo, QuoteResult, QuoteService } from "./quote.service";

@ApiTags("Quotes")
@Controller("api/v1/quotes")
export class QuoteController {
  constructor(private readonly quoteService: QuoteService) {}

  /** POST /api/v1/quotes — calculate a premium quote */
  @Post()
  @ApiOperation({ summary: "Calculate a premium quote" })
  @ApiResponse({ status: 201, description: "Quote calculated" })
  createQuote(@Body() dto: CreateQuoteDto): QuoteResult {
    return this.quoteService.createQuote(dto);
  }

  /** GET /api/v1/quotes/coverage-types — list available coverage with descriptions */
  @Get("coverage-types")
  @ApiOperation({ summary: "List available coverage types and rates" })
  @ApiResponse({ status: 200, description: "Coverage type catalog" })
  listCoverageTypes(): { types: CoverageTypeInfo[] } {
    return { types: this.quoteService.listCoverageTypes() };
  }
}
