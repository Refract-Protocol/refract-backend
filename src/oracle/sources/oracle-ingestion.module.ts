import { Logger, Module } from "@nestjs/common";
import { pushSourcesFromEnv } from "./json-push-source";
import { DEFAULT_INGESTION_CONFIG, OracleIngestionPipeline } from "./oracle-ingestion.pipeline";
import { OracleWebhookController } from "./oracle-webhook.controller";

/**
 * Wires the shared ingestion pipeline and the push webhook endpoint. Push
 * sources come from ORACLE_PUSH_SOURCES (see json-push-source.ts); pull
 * sources register themselves with the exported pipeline.
 */
@Module({
  controllers: [OracleWebhookController],
  providers: [
    {
      provide: OracleIngestionPipeline,
      useFactory: () => {
        const pipeline = new OracleIngestionPipeline(DEFAULT_INGESTION_CONFIG);
        const logger = new Logger("OracleIngestion");
        for (const source of pushSourcesFromEnv(process.env.ORACLE_PUSH_SOURCES)) {
          pipeline.register(source);
          logger.log(`Registered push oracle source ${source.id} (${source.feeds.join(", ")})`);
        }
        return pipeline;
      },
    },
  ],
  exports: [OracleIngestionPipeline],
})
export class OracleIngestionModule {}
