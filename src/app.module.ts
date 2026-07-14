import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import configuration from "./config/configuration";
import { HealthModule } from "./health/health.module";
import { QuoteModule } from "./quote/quote.module";
import { PolicyModule } from "./policy/policy.module";
import { PoolModule } from "./pool/pool.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    HealthModule,
    QuoteModule,
    PolicyModule,
    PoolModule,
  ],
})
export class AppModule {}
