import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import configuration from "./config/configuration";
import { HealthModule } from "./health/health.module";
import { QuoteModule } from "./quote/quote.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    HealthModule,
    QuoteModule,
  ],
})
export class AppModule {}
