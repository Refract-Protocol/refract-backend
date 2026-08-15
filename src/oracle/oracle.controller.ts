import { Controller, Get } from "@nestjs/common";
import { OracleReading } from "./oracle-reading";
import { OracleService } from "./oracle.service";

/**
 * Exposes the same "real" oracle checks (CoinGecko, Horizon, DeFiLlama —
 * see OracleService.checkAll()) that OracleScheduler polls every 60s and
 * broadcasts over the WebSocket feed, but as a plain REST GET. Before this,
 * a client had to open a WebSocket connection and wait for the next
 * above-"low" broadcast to see any oracle data at all — there was no way
 * to just ask "what's the current reading right now."
 */
@Controller("api/v1/oracle")
export class OracleController {
  constructor(private readonly oracleService: OracleService) {}

  @Get("status")
  async getStatus(): Promise<{ readings: OracleReading[] }> {
    return { readings: await this.oracleService.checkAll() };
  }
}
