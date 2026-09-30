import { Controller, Get, Res } from "@nestjs/common";
import { Response } from "express";
import { MetricsService } from "./metrics.service";

@Controller()
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get("metrics")
  async metrics(@Res() response: Response): Promise<void> {
    response.setHeader("Content-Type", this.metricsService.contentType);
    response.send(await this.metricsService.metrics());
  }
}
