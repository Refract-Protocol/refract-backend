import { Module } from "@nestjs/common";
import { StellarModule } from "../stellar/stellar.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [StellarModule],
  controllers: [HealthController],
})
export class HealthModule {}
