import { Controller, Get } from "@nestjs/common";

@Controller()
export class HealthController {
  @Get("health")
  check(): { status: string; protocol: string } {
    return { status: "ok", protocol: "Refract" };
  }
}
