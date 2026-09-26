import { Controller, Get, Optional } from "@nestjs/common";
import { EventIndexerService, EventIndexerStatus } from "../stellar/event-indexer.service";
import { RelayerAccountService, RelayerHealthStatus } from "../stellar/relayer-account.service";
import {
  StellarConfigValidator,
  StellarValidationHealth,
} from "../stellar/stellar-config.validator";

@Controller()
export class HealthController {
  constructor(
    private readonly stellarConfig: StellarConfigValidator,
    private readonly relayerAccount: RelayerAccountService,
    @Optional() private readonly eventIndexer?: EventIndexerService
  ) {}

  @Get("health")
  check(): {
    status: string;
    protocol: string;
    stellar: StellarValidationHealth;
    relayer: RelayerHealthStatus;
    indexer: EventIndexerStatus | null;
  } {
    const stellar = this.stellarConfig.getHealthStatus();
    const relayer = this.relayerAccount.getHealthStatus();
    const indexer = this.eventIndexer?.getStatus() ?? null;
    const degraded =
      !stellar.fullyConfigured ||
      (indexer !== null && (Boolean(indexer.retentionError) || indexer.lagAlert));
    return {
      status: degraded ? "degraded" : "ok",
      protocol: "Refract",
      stellar,
      relayer,
      indexer,
    };
  }
}
