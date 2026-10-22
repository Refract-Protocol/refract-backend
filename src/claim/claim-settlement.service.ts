import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

export interface ClaimSettlementRecord {
  claimId: string;
  feedId: string;
  amount: string;
  currency: string;
  decisionId: string;
  methodologyVersionIds: string[];
  settledAt: Date;
  status: 'settled' | 'held' | 'reversed';
  reason?: string;
}

export interface IncidentEventInput {
  incidentId: string;
  eventType: string;
  feedId: string;
  sourceId?: string;
  decisionId?: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

@Injectable()
export class ClaimSettlementService {
  private readonly logger = new Logger(ClaimSettlementService.name);

  constructor(
    @InjectRepository('ClaimSettlementRecord')
    private readonly settlementRepository: Repository<ClaimSettlementRecord>,
    @InjectRepository('Incident')
    private readonly incidentRepository: Repository<any>,
    @InjectRepository('IncidentEvent')
    private readonly incidentEventRepository: Repository<IncidentEventInput>,
  ) {}

  /**
   * Settle a claim, recording the methodology version ids used for the
   * underlying consensus decision so that historical decisions resolve to
   * the exact methodology semantics in effect at settlement time.
   */
  async settleClaim(params: {
    claimId: string;
    feedId: string;
    amount: string;
    currency: string;
    decisionId: string;
    methodologyVersionIds: string[];
    status: 'settled' | 'held' | 'reversed';
    reason?: string;
  }): Promise<ClaimSettlementRecord> {
    const settledAt = new Date();

    const record: ClaimSettlementRecord = {
      claimId: params.claimId,
      feedId: params.feedId,
      amount: params.amount,
      currency: params.currency,
      decisionId: params.decisionId,
      methodologyVersionIds: [...params.methodologyVersionIds],
      settledAt,
      status: params.status,
      reason: params.reason,
    };

    const saved = await this.settlementRepository.save(record);

    await this.appendIncidentEventForFeed({
      feedId: params.feedId,
      decisionId: params.decisionId,
      status: params.status,
      claimId: params.claimId,
      amount: params.amount,
      currency: params.currency,
      methodologyVersionIds: record.methodologyVersionIds,
      occurredAt: settledAt,
    });

    return saved;
  }

  /**
   * Append a settlement event to any open incident covering the affected feed.
   * Incidents are event-sourced, so the timeline survives a crash and can be
   * rendered deterministically on demand.
   */
  private async appendIncidentEventForFeed(params: {
    feedId: string;
    decisionId: string;
    status: 'settled' | 'held' | 'reversed';
    claimId: string;
    amount: string;
    currency: string;
    methodologyVersionIds: string[];
    occurredAt: Date;
  }): Promise<void> {
    let openIncidents: any[] = [];
    try {
      openIncidents = await this.incidentRepository.find({
        where: { feedId: params.feedId, status: 'open' },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to look up open incidents for feed ${params.feedId}: ${(err as Error).message}`,
      );
      return;
    }

    if (!openIncidents || openIncidents.length === 0) {
      return;
    }

    const eventType =
      params.status === 'settled'
        ? 'claim_settled'
        : params.status === 'held'
          ? 'claim_held'
          : 'claim_reversed';

    for (const incident of openIncidents) {
      const event: IncidentEventInput = {
        incidentId: incident.id,
        eventType,
        feedId: params.feedId,
        decisionId: params.decisionId,
        payload: {
          claimId: params.claimId,
          amount: params.amount,
          currency: params.currency,
          status: params.status,
          decisionId: params.decisionId,
          methodologyVersionIds: params.methodologyVersionIds,
        },
        occurredAt: params.occurredAt,
      };

      try {
        await this.incidentEventRepository.save(event);
      } catch (err) {
        this.logger.warn(
          `Failed to append ${eventType} event to incident ${incident.id}: ${(err as Error).message}`,
        );
      }
    }
  }
}