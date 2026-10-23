import { Controller, Get, HttpCode, HttpException, Logger, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { OpsAuthGuard } from "../../common/guards/ops-auth.guard";
import { RegionalQuorumAggregator } from "./regional-quorum.aggregator";

/** Signed report intake for regional pollers. Authenticated by HMAC, not API key. */
@Controller("api/v1/oracle/regions")
export class OracleRegionsController {
  private readonly logger = new Logger(OracleRegionsController.name);

  constructor(private readonly aggregator: RegionalQuorumAggregator) {}

  @Post(":region/observations")
  @HttpCode(202)
  async report(@Param("region") region: string, @Req() req: RawBodyRequest<Request>) {
    const result = await this.aggregator.ingestSignedReport(region, { headers: req.headers, rawBody: req.rawBody }, Date.now());
    if (!result.ok) {
      this.logger.warn(`Rejected regional report region=${region} reason=${result.reason}`);
      if (result.status === 401) throw new HttpException({ error: "Unauthorized" }, 401);
      throw new HttpException({ error: result.reason }, result.status);
    }
    return result;
  }
}

/** Ops view of per-feed regional agreement and detected correlated failures. */
@Controller("api/v1/ops/oracle/quorum")
@UseGuards(OpsAuthGuard)
export class OracleQuorumOpsController {
  constructor(private readonly aggregator: RegionalQuorumAggregator) {}

  @Get()
  async all() {
    return { ...this.aggregator.quorumStatus(), regions: this.aggregator.profiles(), feeds: await this.aggregator.evaluateAll(Date.now()) };
  }

  @Get(":feedId")
  one(@Param("feedId") feedId: string) {
    return this.aggregator.peek(feedId, Date.now());
  }
}
