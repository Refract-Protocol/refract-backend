import { Module } from "@nestjs/common";
import { EgressHttpClientFactory } from "./egress-http-client.factory";
import { MetricsModule } from "../../metrics/metrics.module";

/**
 * Provides EgressHttpClientFactory — the single entry point for all provider
 * adapter outbound HTTP requests.  Import this module wherever adapters live;
 * do NOT use fetch/axios directly (enforced by the lint rule).
 */
@Module({
  imports: [MetricsModule],
  providers: [EgressHttpClientFactory],
  exports: [EgressHttpClientFactory],
})
export class EgressHttpModule {}
