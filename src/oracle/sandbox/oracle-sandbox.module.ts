import { Logger, Module, OnModuleInit } from "@nestjs/common";
import { OracleSandboxController } from "./oracle-sandbox.controller";
import { OracleSandboxService } from "./oracle-sandbox.service";
import { assertOracleSandboxSafety, loadOracleSandboxConfig } from "./oracle-sandbox.config";

/**
 * Registered by AppModule only when ORACLE_SANDBOX_MODE=true. It depends on
 * nothing that can write to Postgres, Redis, or Soroban.
 */
@Module({
  controllers: [OracleSandboxController],
  providers: [
    {
      provide: OracleSandboxService,
      useFactory: () => new OracleSandboxService(loadOracleSandboxConfig()),
    },
  ],
  exports: [OracleSandboxService],
})
export class OracleSandboxModule implements OnModuleInit {
  private readonly logger = new Logger(OracleSandboxModule.name);

  onModuleInit(): void {
    assertOracleSandboxSafety();
    const { policy } = loadOracleSandboxConfig();
    this.logger.warn(
      `ORACLE PROVIDER SANDBOX ENABLED: readings are corroborated in memory and never published on-chain ` +
        `(minProviders=${policy.minProviders}, maxDeviationRatio=${policy.maxDeviationRatio}, windowMs=${policy.windowMs})`,
    );
  }
}
