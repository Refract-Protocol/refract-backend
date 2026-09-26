import { Controller, Get } from "@nestjs/common";

@Controller({ path: "health", version: undefined })
export class HealthController {
  @Get()
  check() {
    return { status: "ok" };
  }
}
