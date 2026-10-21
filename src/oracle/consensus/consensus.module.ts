import { Module } from "@nestjs/common";
import { ClaimHoldScheduler } from "./claim-hold.scheduler";
import { ClaimHoldService } from "./claim-hold.service";
import { CONSENSUS_CONFIG, ConsensusConfig, EVIDENCE_LEDGER, loadConsensusConfig, PAYLOAD_STORE } from "./consensus.config";
import { ConsensusController } from "./consensus.controller";
import { ConsensusRoleGuard } from "./consensus-role.guard";
import { ConsensusService } from "./consensus.service";
import { createCredentialStore, SOURCE_CREDENTIAL_STORE } from "./credential-store";
import { EvidenceLedger, PayloadStore } from "./evidence-ledger";
import { loadMirrorDetectionConfig } from "./fingerprint";
import { MIRROR_CONFIG, MirrorDetectionService } from "./mirror-detection";
import { OffboardingService } from "./offboarding";

@Module({
  controllers: [ConsensusController],
  providers: [
    { provide: CONSENSUS_CONFIG, useFactory: () => loadConsensusConfig() },
    { provide: MIRROR_CONFIG, useFactory: () => loadMirrorDetectionConfig() },
    { provide: SOURCE_CREDENTIAL_STORE, useFactory: () => createCredentialStore() },
    {
      provide: EVIDENCE_LEDGER,
      inject: [CONSENSUS_CONFIG],
      useFactory: (config: ConsensusConfig) => new EvidenceLedger(config.ledgerPath),
    },
    {
      provide: PAYLOAD_STORE,
      inject: [CONSENSUS_CONFIG],
      useFactory: (config: ConsensusConfig) => new PayloadStore(config.payloadDir),
    },
    ConsensusRoleGuard,
    ConsensusService,
    ClaimHoldService,
    ClaimHoldScheduler,
    MirrorDetectionService,
    OffboardingService,
  ],
  exports: [ConsensusService, ClaimHoldService, MirrorDetectionService, OffboardingService, EVIDENCE_LEDGER, PAYLOAD_STORE, CONSENSUS_CONFIG],
})
export class ConsensusModule {}
