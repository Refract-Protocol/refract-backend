import { Module } from "@nestjs/common";
import { PoolModule } from "../pool/pool.module";
import { QuoteController } from "./quote.controller";
import { QuoteService } from "./quote.service";

@Module({
  imports: [PoolModule],
  controllers: [QuoteController],
  providers: [QuoteService],
  exports: [QuoteService],
})
export class QuoteModule {}
