import { Controller, HttpCode, HttpException, Logger, Param, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { OracleIngestionPipeline } from "./oracle-ingestion.pipeline";

/**
 * Inbound webhook for push-based oracle providers.
 *
 * Needs the unparsed request bytes to verify the signature, so main.ts creates
 * the app with `rawBody: true`. Every auth failure gets the same 401 body; the
 * specific reason is only logged.
 */
@Controller("api/v1/oracle/webhooks")
export class OracleWebhookController {
  private readonly logger = new Logger(OracleWebhookController.name);

  constructor(private readonly pipeline: OracleIngestionPipeline) {}

  @Post(":sourceId")
  @HttpCode(202)
  async receive(@Param("sourceId") sourceId: string, @Req() req: RawBodyRequest<Request>) {
    const result = await this.pipeline.ingestWebhook(
      sourceId,
      { headers: req.headers, rawBody: req.rawBody },
      Date.now(),
    );

    if (!result.ok) {
      this.logger.warn(`Rejected oracle webhook source=${sourceId} reason=${result.reason}`);
      if (result.status === 401) throw new HttpException({ error: "Unauthorized" }, 401);
      throw new HttpException({ error: result.reason }, result.status);
    }

    if (result.rejected.length > 0) {
      this.logger.warn(
        `Oracle webhook source=${sourceId} rejected ${result.rejected.length} reading(s): ${result.rejected
          .map((r) => `${r.reading.feedId}:${r.reason}`)
          .join(", ")}`,
      );
    }
    return {
      accepted: result.accepted.length,
      rejected: result.rejected.map((r) => ({ feedId: r.reading.feedId, observedAt: r.reading.observedAt, reason: r.reason })),
    };
  }
}
