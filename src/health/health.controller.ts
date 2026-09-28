import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";

@ApiTags("Health")
@Controller()
export class HealthController {
  @Get("health")
  @ApiOperation({ summary: "Check API liveness" })
  @ApiResponse({ status: 200, description: "Service is healthy" })
  check(): { status: string; protocol: string } {
    return { status: "ok", protocol: "Refract" };
  }
}
