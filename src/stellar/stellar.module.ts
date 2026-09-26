import { Module } from "@nestjs/common";
import { ClaimRepository } from "../claim/claim.repository";
import { PolicyRepository } from "../policy/policy.repository";
import { LpPositionRepository } from "../pool/lp-position.repository";
import { EventIndexerService } from "./event-indexer.service";
import { CapitalProvidedHandler } from "./handlers/capital-provided.handler";
import { CapitalWithdrawnHandler } from "./handlers/capital-withdrawn.handler";
import { ClaimProcessedHandler } from "./handlers/claim-processed.handler";
import { PolicyPurchasedHandler } from "./handlers/policy-purchased.handler";
import { IndexerCursorRepository } from "./indexer-cursor.repository";
import { RelayerAccountService } from "./relayer-account.service";
import { StellarConfigValidator } from "./stellar-config.validator";

/**
 * Stellar/Soroban infrastructure shared by claim settlement, pool/policy
 * write paths, oracle publishing, event indexing, and health.
 *
 * Event indexer: only ONE replica should enable EVENT_INDEXER_ENABLED.
 */
@Module({
  providers: [
    StellarConfigValidator,
    RelayerAccountService,
    IndexerCursorRepository,
    PolicyRepository,
    LpPositionRepository,
    ClaimRepository,
    PolicyPurchasedHandler,
    CapitalProvidedHandler,
    CapitalWithdrawnHandler,
    ClaimProcessedHandler,
    EventIndexerService,
  ],
  exports: [
    StellarConfigValidator,
    RelayerAccountService,
    EventIndexerService,
    PolicyRepository,
    LpPositionRepository,
    ClaimRepository,
  ],
})
export class StellarModule {}
