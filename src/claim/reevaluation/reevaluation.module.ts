import { Injectable, Logger, Module, OnModuleInit } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { OracleRegionsModule } from "../../oracle/regions/oracle-regions.module";
import { RegionalQuorumAggregator } from "../../oracle/regions/regional-quorum.aggregator";
import { ClaimService } from "../claim.service";
import { OpsReevaluationController, REEVALUATION_EXECUTOR } from "./ops-reevaluation.controller";
import { ReevaluationItem } from "./reevaluation-planner";
import { ReevaluationRun, ReevaluationService, ReevaluationSettlementExecutor } from "./reevaluation.service";

/** Pays re-adjudicated claims through ClaimService's normal settlement path. */
@Injectable()
export class ClaimServiceReevaluationExecutor implements ReevaluationSettlementExecutor {
  constructor(private readonly moduleRef: ModuleRef) {}

  async settle(item: ReevaluationItem, run: ReevaluationRun) {
    const claims = this.moduleRef.get(ClaimService, { strict: false });
    return claims.settleFromReevaluation(
      { id: item.policyId, holder: item.holder, coverageType: item.coverageType, coverageAmount: item.payoutDelta },
      run.runId,
    );
  }
}

/** Connects the regional quorum, ClaimService and the re-evaluation service at boot. */
@Injectable()
export class ReevaluationWiring implements OnModuleInit {
  private readonly logger = new Logger(ReevaluationWiring.name);

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly aggregator: RegionalQuorumAggregator,
    private readonly service: ReevaluationService,
  ) {}

  onModuleInit(): void {
    this.aggregator.onVerdict((v) => this.service.onVerdict(v));
    this.aggregator.onTrustTransition((t) => {
      this.service.onTrustTransition(t);
    });

    let claims: ClaimService | undefined;
    try {
      claims = this.moduleRef.get(ClaimService, { strict: false });
    } catch {
      claims = undefined;
    }
    if (!claims) {
      this.logger.warn("ClaimService not available; claim decisions won't be recorded for re-evaluation");
      return;
    }
    // trustState() is null for feeds no region reports on, so those stay ungated.
    claims.setTrustGate((feedId) => this.aggregator.trustState(feedId));
    claims.onAdjudication((record) => this.service.ledger.record(record));
  }
}

@Module({
  imports: [OracleRegionsModule],
  controllers: [OpsReevaluationController],
  providers: [
    { provide: ReevaluationService, useFactory: () => new ReevaluationService() },
    { provide: REEVALUATION_EXECUTOR, useClass: ClaimServiceReevaluationExecutor },
    ReevaluationWiring,
  ],
  exports: [ReevaluationService],
})
export class ReevaluationModule {}
