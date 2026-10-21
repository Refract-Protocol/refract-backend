import { Module } from "@nestjs/common";
import { ClaimHoldScheduler } from "./claim-hold.scheduler";
import { ClaimHoldService } from "./claim-hold.service";
import { CONSENSUS_CONFIG, ConsensusConfig, EVIDENCE_LEDGER, loadConsensusConfig, PAYLOAD_STORE } from "./consensus.config";
import { ConsensusController } from "./consensus.controller";
import { ConsensusRoleGuard } from "./consensus-role.guard";
import { ConsensusService } from "./consensus.service";
import { EvidenceLedger, PayloadStore } from "./evidence-ledger";

@Module({
  controllers: [ConsensusController],
  providers: [
    { provide: CONSENSUS_CONFIG, useFactory: () => loadConsensusConfig() },
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
  ],
  exports: [ConsensusService, ClaimHoldService, EVIDENCE_LEDGER, PAYLOAD_STORE, CONSENSUS_CONFIG],
})
export class ConsensusModule {}
