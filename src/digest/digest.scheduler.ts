import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { TreasuryService } from '../treasury/treasury.service';
import { ClaimsService } from '../claims/claims.service';
import { PoliciesService } from '../policies/policies.service';

export interface DigestCadence {
  /** Interval between digest runs in milliseconds. Defaults to 24h. */
  intervalMs?: number;
}

export interface DigestPayload {
  generatedAt: string;
  periodStart: string;
  periodEnd: string;
  newPoliciesByCoverageType: Record<string, number>;
  claimsTriggered: { count: number; totalAmount: number };
  claimsSettled: { count: number; totalAmount: number };
  netPoolCapitalChange: number;
  needsReviewClaims: number;
  deadLetteredClaims: number;
  hasActivity: boolean;
}

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class DigestScheduler implements OnModuleInit {
  private readonly logger = new Logger(DigestScheduler.name);
  private timer?: NodeJS.Timeout;
  private lastRunAt: Date;

  constructor(
    private readonly notifications: NotificationsService,
    private readonly analytics: AnalyticsService,
    private readonly treasury: TreasuryService,
    private readonly claims: ClaimsService,
    private readonly policies: PoliciesService,
  ) {
    this.lastRunAt = new Date();
  }

  onModuleInit(): void {
    const intervalMs = this.resolveInterval();
    this.timer = setInterval(() => {
      void this.runDigest();
    }, intervalMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
    this.logger.log(`Digest scheduler started with cadence ${intervalMs}ms`);
  }

  private resolveInterval(): number {
    const configured = Number(process.env.DIGEST_INTERVAL_MS);
    if (Number.isFinite(configured) && configured > 0) {
      return configured;
    }
    return DEFAULT_INTERVAL_MS;
  }

  /** Compiles the digest for the elapsed period and delivers it via the webhook service. */
  async runDigest(now: Date = new Date()): Promise<DigestPayload> {
    const periodStart = this.lastRunAt;
    const periodEnd = now;
    const payload = await this.compileDigest(periodStart, periodEnd);
    this.lastRunAt = periodEnd;
    await this.notifications.deliverWebhook({
      event: 'protocol.digest',
      payload,
    });
    return payload;
  }

  /** Builds the structured digest from existing aggregation queries. */
  async compileDigest(periodStart: Date, periodEnd: Date): Promise<DigestPayload> {
    const [policiesByType, lossRatio, treasuryReport, triggered, settled, reviewClaims] =
      await Promise.all([
        this.policies.countByCoverageType(periodStart, periodEnd),
        this.analytics.getLossRatio(periodStart, periodEnd),
        this.treasury.getReport(periodStart, periodEnd),
        this.claims.listByStatus('triggered', periodStart, periodEnd),
        this.claims.listByStatus('settled', periodStart, periodEnd),
        this.claims.listNeedsReview(periodStart, periodEnd),
      ]);

    const claimsTriggered = {
      count: triggered.length,
      totalAmount: triggered.reduce((sum, c) => sum + (c.amount ?? 0), 0),
    };
    const claimsSettled = {
      count: settled.length,
      totalAmount: settled.reduce((sum, c) => sum + (c.amount ?? 0), 0),
    };

    const newPoliciesByCoverageType = policiesByType;
    const netPoolCapitalChange = treasuryReport.netCapitalChange ?? 0;
    const needsReviewClaims = reviewClaims.filter((c) => !c.deadLettered).length;
    const deadLetteredClaims = reviewClaims.filter((c) => c.deadLettered).length;

    const hasActivity =
      Object.values(newPoliciesByCoverageType).some((n) => n > 0) ||
      claimsTriggered.count > 0 ||
      claimsSettled.count > 0 ||
      netPoolCapitalChange !== 0 ||
      needsReviewClaims > 0 ||
      deadLetteredClaims > 0 ||
      lossRatio.sampleSize > 0;

    return {
      generatedAt: periodEnd.toISOString(),
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      newPoliciesByCoverageType,
      claimsTriggered,
      claimsSettled,
      netPoolCapitalChange,
      needsReviewClaims,
      deadLetteredClaims,
      hasActivity,
    };
  }
}
