import { Controller, Get, HttpCode, HttpStatus, Res } from "@nestjs/common";
import { Response } from "express";
import { Public } from "../auth/public.decorator";
import { HealthService } from "./health.service";

@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * @deprecated Use GET /health/live or GET /health/ready instead.
   * Retained for backward compatibility.
   */
  @Public()
  @Get()
  getHealth() {
    return {
      status: "ok",
      protocol: "Refract",
      deprecated: true,
      message: "Use /health/live or /health/ready",
    };
  }

  /**
   * Process-level liveness only. Never touches a dependency, so a transient
   * dependency outage can never cause an orchestrator to kill a healthy pod.
   */
  @Public()
  @Get("live")
  @HttpCode(HttpStatus.OK)
  getLiveness() {
    return this.healthService.getLiveness();
  }

  /**
   * Aggregated readiness across database, Redis, Soroban RPC and Stellar
   * configuration. Returns 503 when any required dependency is not ready.
   */
  @Public()
  @Get("ready")
  async getReadiness(@Res({ passthrough: true }) res: Response) {
    const result = await this.healthService.getReadiness();
    res.status(result.ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }

  /**
   * Detailed per-dependency report. Authenticated (no @Public decorator) and
   * never exposes the relayer secret — only the derived public key.
   */
  @Get("detail")
  async getDetail() {
    return this.healthService.getDetail();
  }
}
