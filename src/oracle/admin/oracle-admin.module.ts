import { Logger, Module, OnApplicationBootstrap } from "@nestjs/common";
import { OracleBootstrapModule } from "../bootstrap/oracle-bootstrap.module";
import { SourceBootstrapService } from "../bootstrap/source-bootstrap.service";
import { loadOracleConfig } from "../config/oracle-feed-config";
import { FixedWindowLimiter, operatorRateLimitsFromEnv } from "./actor-rate-limiter";
import { OracleAdminController } from "./oracle-admin.controller";
import { OracleAuditLog, currentActor } from "./oracle-audit";
import { OracleControlRegistry } from "./oracle-control.registry";
import { OperatorAuthenticator, parseOperatorCredentials } from "./operator-identity";
import {
  ORACLE_OPERATOR_LIMITER,
  ORACLE_OPERATOR_RATE_LIMITS,
  OracleAuditInterceptor,
  OracleOperatorGuard,
} from "./oracle-operator.guard";

const logger = new Logger("OracleAdmin");

/**
 * Operator-facing oracle controls with authentication, role-based
 * authorization, per-actor rate limiting, and audit identity propagation.
 *
 * ORACLE_OPERATOR_KEYS is parsed at startup, so a malformed key list stops
 * the process. If it is unset, every operator endpoint answers 503.
 */
@Module({
  imports: [OracleBootstrapModule],
  controllers: [OracleAdminController],
  providers: [
    {
      provide: OperatorAuthenticator,
      useFactory: () => {
        const credentials = parseOperatorCredentials(process.env.ORACLE_OPERATOR_KEYS);
        if (credentials.length === 0) {
          logger.warn("ORACLE_OPERATOR_KEYS is not set; operator oracle endpoints will refuse all requests");
        }
        return new OperatorAuthenticator(credentials);
      },
    },
    { provide: ORACLE_OPERATOR_RATE_LIMITS, useFactory: () => operatorRateLimitsFromEnv() },
    { provide: ORACLE_OPERATOR_LIMITER, useFactory: () => new FixedWindowLimiter() },
    { provide: OracleAuditLog, useFactory: () => new OracleAuditLog() },
    {
      provide: OracleControlRegistry,
      inject: [SourceBootstrapService],
      useFactory: (bootstrap: SourceBootstrapService) =>
        new OracleControlRegistry(loadOracleConfig().config, {
          network: process.env.STELLAR_NETWORK ?? "testnet",
          // Onboarding a source through the API bootstraps it straight away, as the acting operator.
          onSourcesAdded: (feedId, sources) => {
            const requestedBy = currentActor();
            const real = sources.filter((s) => s.adapter !== "mock");
            if (real.length === 0) return;
            void bootstrap
              .bootstrapFeed(
                feedId,
                real.map((s) => ({ sourceId: s.id, adapter: s.adapter, params: s.params })),
                { requestedBy }
              )
              .catch((error) => logger.error(`Bootstrap of new sources on ${feedId} failed: ${String(error)}`));
          },
        }),
    },
    OracleOperatorGuard,
    OracleAuditInterceptor,
  ],
  exports: [OracleControlRegistry],
})
export class OracleAdminModule implements OnApplicationBootstrap {
  constructor(
    private readonly registry: OracleControlRegistry,
    private readonly bootstrap: SourceBootstrapService
  ) {}

  /**
   * Sources onboarded through the config file are bootstrapped at startup.
   * Warm sources are skipped, so this is cheap after the first run. It runs
   * in the background and never blocks startup. Set
   * ORACLE_BOOTSTRAP_ON_STARTUP=false to turn it off.
   */
  onApplicationBootstrap(): void {
    if ((process.env.ORACLE_BOOTSTRAP_ON_STARTUP ?? "true").toLowerCase() === "false") return;
    for (const feed of this.registry.listFeeds()) {
      const sources = feed.definition.sources
        .filter((s) => s.enabled !== false && s.adapter !== "mock")
        .map((s) => ({ sourceId: s.id, adapter: s.adapter, params: s.params }));
      if (sources.length === 0) continue;
      void this.bootstrap
        .bootstrapFeed(feed.definition.id, sources, { requestedBy: "system:startup" })
        .catch((error) => logger.error(`Startup bootstrap of ${feed.definition.id} failed: ${String(error)}`));
    }
  }
}
