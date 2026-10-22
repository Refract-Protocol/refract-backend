import { Injectable, Logger } from "@nestjs/common";
import { MetricsService } from "../../metrics/metrics.service";
import { AdapterEgressPolicy } from "./egress-policy";
import { EgressHttpClient, EgressMetricsSink } from "./egress-http-client";

/**
 * NestJS-injectable factory that creates EgressHttpClient instances wired to
 * the shared MetricsService counter/histogram for egress deny events.
 */
@Injectable()
export class EgressHttpClientFactory {
  private readonly logger = new Logger(EgressHttpClientFactory.name);

  constructor(private readonly metrics: MetricsService) {}

  create(policy: AdapterEgressPolicy): EgressHttpClient {
    const sink = this.buildSink();
    return new EgressHttpClient(policy, undefined, sink);
  }

  private buildSink(): EgressMetricsSink {
    const metrics = this.metrics;
    const logger = this.logger;

    return {
      recordEgressDenied(reason, host) {
        // Surface as oracle check "failure" tagged by reason so the existing
        // Prometheus dashboard picks it up without a schema change.
        metrics.recordOracleCheck(`egress:${reason}`, "failure", 0);
        logger.warn(
          JSON.stringify({ event: "egress_denied_metric", reason, host }),
        );
      },
      recordEgressRequest(host, outcome) {
        metrics.recordOracleCheck(`egress:${host}`, outcome === "success" ? "success" : "failure", 0);
      },
    };
  }
}
