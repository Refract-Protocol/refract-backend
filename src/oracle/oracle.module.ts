import { Module } from "@nestjs/common";
import { MetricsService } from "../metrics/metrics.service";
import { CoinGeckoAdapter } from "./adapters/coingecko.adapter";
import { DefiLlamaAdapter } from "./adapters/defillama.adapter";
import { HorizonAdapter } from "./adapters/horizon.adapter";
import {
  ORACLE_OBSERVABILITY_SINK,
  OracleObservabilitySink,
  OracleSourceRegistry,
} from "./adapters/source-registry";
import { OracleEventRepository } from "./oracle-event.repository";
import { OracleGateway } from "./oracle.gateway";
import { OracleScheduler } from "./oracle.scheduler";
import { OracleService } from "./oracle.service";
import { loadOracleTrustConfig, ORACLE_TRUST_CONFIG, OracleTrustConfig } from "./oracle-trust.config";

@Module({
  providers: [
    { provide: ORACLE_TRUST_CONFIG, useFactory: () => loadOracleTrustConfig() },
    {
      provide: ORACLE_OBSERVABILITY_SINK,
      inject: [{ token: MetricsService, optional: true }],
      useFactory: (metrics?: MetricsService): OracleObservabilitySink => ({
        recordSourceObservation: (source, metric, outcome) =>
          metrics?.recordOracleSourceObservation(source, metric, outcome),
        recordQuarantine: (source, metric) => metrics?.recordOracleSourceQuarantine(source, metric),
      }),
    },
    {
      provide: OracleSourceRegistry,
      inject: [ORACLE_TRUST_CONFIG, ORACLE_OBSERVABILITY_SINK],
      useFactory: (config: OracleTrustConfig, sink: OracleObservabilitySink) =>
        new OracleSourceRegistry({
          timeoutMs: config.httpTimeoutMs,
          quarantineAfterFailures: config.quarantineAfterFailures,
          quarantineMs: config.quarantineMs,
          sink,
        })
          .register(new CoinGeckoAdapter(config.coingeckoBaseUrl))
          .register(new HorizonAdapter(config.horizonUrl))
          .register(new DefiLlamaAdapter(config.defiLlamaBaseUrl, config.defiLlamaProtocolSlug)),
    },
    OracleService,
    OracleEventRepository,
    OracleGateway,
    OracleScheduler,
  ],
  exports: [ORACLE_TRUST_CONFIG, OracleSourceRegistry, OracleService, OracleEventRepository, OracleGateway],
})
export class OracleModule {}
