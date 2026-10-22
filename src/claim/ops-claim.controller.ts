import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { Scopes } from '../auth/scopes.decorator';
import { ScopesGuard } from '../auth/scopes.guard';
import { AuditService } from '../audit/audit.service';
import { ClaimService } from './claim.service';
import { OverridePreviewService } from './override-preview.service';

interface OpsRequest extends Request {
  apiKey?: { id?: string; name?: string };
}

interface OverridePreviewBody {
  feedId?: string;
  value?: number | null;
  suppressed?: boolean;
  effectiveFrom?: string;
  effectiveTo?: string;
  rationale?: string;
}

interface OverrideApplyBody extends OverridePreviewBody {
  previewId?: string;
  approvalId?: string;
}

@ApiExcludeController()
@Controller('api/v1/ops/claims')
@UseGuards(AuthGuard, ScopesGuard)
@Scopes('ops:read')
export class OpsClaimController {
  constructor(
    private readonly claimService: ClaimService,
    private readonly auditService: AuditService,
    private readonly overridePreviewService: OverridePreviewService,
  ) {}

  @Post('scan')
  @Scopes('ops:write')
  async scan(
    @Query('dryRun') dryRun: string,
    @Req() req: OpsRequest,
  ) {
    const isDryRun = dryRun === 'true' || dryRun === '1';
    const actor = this.actor(req);

    if (this.claimService.isScanRunning()) {
      await this.auditService.record({
        actor,
        action: 'ops.claims.scan',
        params: { dryRun: isDryRun },
        outcome: 'conflict',
      });
      throw new HttpException(
        'A claim scan is already running',
        HttpStatus.CONFLICT,
      );
    }

    try {
      const result = await this.claimService.runScan({ dryRun: isDryRun });
      await this.auditService.record({
        actor,
        action: 'ops.claims.scan',
        params: { dryRun: isDryRun },
        outcome: 'success',
        detail: { evaluated: result.evaluated, triggered: result.triggered },
      });
      return result;
    } catch (err) {
      await this.auditService.record({
        actor,
        action: 'ops.claims.scan',
        params: { dryRun: isDryRun },
        outcome: 'error',
        detail: { message: (err as Error).message },
      });
      throw err;
    }
  }

  @Post(':policyId/settle')
  @Scopes('ops:write')
  async settle(
    @Param('policyId') policyId: string,
    @Query('dryRun') dryRun: string,
    @Query('confirm') confirm: string,
    @Req() req: OpsRequest,
  ) {
    const isDryRun = dryRun === 'true' || dryRun === '1';
    const actor = this.actor(req);

    if (!isDryRun && confirm !== 'true') {
      await this.auditService.record({
        actor,
        action: 'ops.claims.settle',
        params: { policyId, dryRun: isDryRun },
        outcome: 'rejected',
      });
      throw new HttpException(
        'Force-settle requires confirm=true',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const result = await this.claimService.settlePolicy(policyId, {
        dryRun: isDryRun,
      });
      await this.auditService.record({
        actor,
        action: 'ops.claims.settle',
        params: { policyId, dryRun: isDryRun },
        outcome: 'success',
        detail: { triggered: result.triggered },
      });
      return result;
    } catch (err) {
      await this.auditService.record({
        actor,
        action: 'ops.claims.settle',
        params: { policyId, dryRun: isDryRun },
        outcome: 'error',
        detail: { message: (err as Error).message },
      });
      throw err;
    }
  }

  @Get('scan-history')
  async scanHistory(@Query('limit') limit?: string) {
    const parsed = limit ? Number.parseInt(limit, 10) : undefined;
    return this.claimService.getScanHistory(
      Number.isFinite(parsed) ? parsed : undefined,
    );
  }

  @Post('overrides/preview')
  @Scopes('ops:override:preview')
  async previewOverride(
    @Body() body: OverridePreviewBody,
    @Req() req: OpsRequest,
  ) {
    const actor = this.actor(req);
    const params = this.overrideParams(body);

    try {
      const preview = await this.overridePreviewService.createPreview(
        params,
        actor,
      );
      await this.auditService.record({
        actor,
        action: 'ops.claims.override.preview',
        params: { ...params, previewId: preview.previewId },
        outcome: 'success',
        detail: {
          affectedPolicies: preview.affectedPolicies,
          totalExposure: preview.totalExposure,
          truncated: preview.truncated,
        },
      });
      return preview;
    } catch (err) {
      await this.auditService.record({
        actor,
        action: 'ops.claims.override.preview',
        params,
        outcome: 'error',
        detail: { message: (err as Error).message },
      });
      throw err;
    }
  }

  @Post('overrides/apply')
  @Scopes('ops:override:apply')
  async applyOverride(
    @Body() body: OverrideApplyBody,
    @Req() req: OpsRequest,
  ) {
    const actor = this.actor(req);
    const params = this.overrideParams(body);

    if (!body.previewId) {
      await this.auditService.record({
        actor,
        action: 'ops.claims.override.apply',
        params,
        outcome: 'rejected',
        detail: { reason: 'missing_preview_id' },
      });
      throw new HttpException(
        'Applying an override requires a previewId from a recent preview',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const result = await this.overridePreviewService.applyPreview(
        body.previewId,
        params,
        actor,
        { approvalId: body.approvalId },
      );
      await this.auditService.record({
        actor,
        action: 'ops.claims.override.apply',
        params: { ...params, previewId: body.previewId },
        outcome: 'success',
        detail: {
          applied: result.applied,
          totalExposure: result.totalExposure,
        },
      });
      return result;
    } catch (err) {
      await this.auditService.record({
        actor,
        action: 'ops.claims.override.apply',
        params: { ...params, previewId: body.previewId },
        outcome: 'error',
        detail: { message: (err as Error).message },
      });
      throw err;
    }
  }

  private overrideParams(body: OverridePreviewBody) {
    return {
      feedId: body.feedId,
      value: body.value ?? null,
      suppressed: body.suppressed === true,
      effectiveFrom: body.effectiveFrom,
      effectiveTo: body.effectiveTo,
      rationale: body.rationale,
    };
  }

  private actor(req: OpsRequest): string {
    return req.apiKey?.name ?? req.apiKey?.id ?? 'unknown';
  }
}
