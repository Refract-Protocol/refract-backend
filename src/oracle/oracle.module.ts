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
import { ConsensusService } from "./consensus/consensus.service";
import { EVIDENCE_STORE, EvidenceStore } from "./evidence/evidence-record";
import { EvidenceSpool } from "./evidence/evidence-spool";
import { OracleEvidenceBuffer } from "./evidence/oracle-evidence-buffer";
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
    { provide: EVIDENCE_STORE, useExisting: OracleEventRepository },
    {
      provide: OracleEvidenceBuffer,
      inject: [ORACLE_TRUST_CONFIG, EVIDENCE_STORE, { token: MetricsService, optional: true }],
      useFactory: (config: OracleTrustConfig, store: EvidenceStore, metrics?: MetricsService) =>
        new OracleEvidenceBuffer(new EvidenceSpool(config.evidenceSpoolDir, config.evidenceSpoolMaxBytes), store, {
          batchSize: 500,
          baseBackoffMs: 1_000,
          maxBackoffMs: 60_000,
          compactEveryBatches: 20,
          onStatus: (s) => metrics?.setOracleEvidenceStatus(s.pending, s.lostTotal, s.complete),
        }),
    },
    {
      provide: ConsensusService,
      inject: [OracleSourceRegistry, OracleEvidenceBuffer, ORACLE_TRUST_CONFIG],
      useFactory: (registry: OracleSourceRegistry, evidence: OracleEvidenceBuffer, config: OracleTrustConfig) =>
        new ConsensusService(registry, evidence, {
          minSources: config.consensusMinSources,
          targetSources: config.consensusTargetSources,
          minConfidence: config.consensusMinConfidence,
          decisionTtlMs: config.consensusDecisionTtlMs,
        }),
    },
    OracleGateway,
    OracleScheduler,
  ],
  exports: [ORACLE_TRUST_CONFIG, OracleSourceRegistry, OracleService, OracleEvidenceBuffer, ConsensusService, OracleGateway],
})
export class OracleModule {}
