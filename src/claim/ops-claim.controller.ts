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
import { MethodologyService } from '../oracle/methodology.service';
import { IncidentService } from '../services/incident.service';

interface OpsRequest extends Request {
  apiKey?: { id?: string; name?: string };
}

@ApiExcludeController()
@Controller('api/v1/ops/claims')
@UseGuards(AuthGuard, ScopesGuard)
@Scopes('ops:read')
export class OpsClaimController {
  constructor(
    private readonly claimService: ClaimService,
    private readonly auditService: AuditService,
    private readonly methodologyService: MethodologyService,
    private readonly incidentService: IncidentService,
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

  @Get('methodologies')
  async listMethodologies(@Query('sourceId') sourceId?: string) {
    return this.methodologyService.listMethodologies(sourceId);
  }

  @Get('methodologies/:sourceId/:version')
  async getMethodology(
    @Param('sourceId') sourceId: string,
    @Param('version') version: string,
  ) {
    const parsed = Number.parseInt(version, 10);
    if (!Number.isFinite(parsed)) {
      throw new HttpException('Invalid version', HttpStatus.BAD_REQUEST);
    }
    return this.methodologyService.getMethodology(sourceId, parsed);
  }

  @Post('methodologies')
  @Scopes('ops:write')
  async createMethodology(
    @Body() body: Record<string, unknown>,
    @Req() req: OpsRequest,
  ) {
    const actor = this.actor(req);
    try {
      const record = await this.methodologyService.createMethodology(body, actor);
      await this.auditService.record({
        actor,
        action: 'ops.methodology.create',
        params: { sourceId: record.sourceId, version: record.version },
        outcome: 'success',
      });
      return record;
    } catch (err) {
      await this.auditService.record({
        actor,
        action: 'ops.methodology.create',
        params: { sourceId: body?.sourceId },
        outcome: 'error',
        detail: { message: (err as Error).message },
      });
      throw err;
    }
  }

  @Post('methodologies/:sourceId/:version/approve')
  @Scopes('ops:write')
  async approveMethodology(
    @Param('sourceId') sourceId: string,
    @Param('version') version: string,
    @Body() body: Record<string, unknown>,
    @Req() req: OpsRequest,
  ) {
    const parsed = Number.parseInt(version, 10);
    if (!Number.isFinite(parsed)) {
      throw new HttpException('Invalid version', HttpStatus.BAD_REQUEST);
    }
    const actor = this.actor(req);
    try {
      const record = await this.methodologyService.approveMethodology(
        sourceId,
        parsed,
        body,
        actor,
      );
      await this.auditService.record({
        actor,
        action: 'ops.methodology.approve',
        params: { sourceId, version: parsed },
        outcome: 'success',
      });
      return record;
    } catch (err) {
      await this.auditService.record({
        actor,
        action: 'ops.methodology.approve',
        params: { sourceId, version: parsed },
        outcome: 'error',
        detail: { message: (err as Error).message },
      });
      throw err;
    }
  }

  @Get('incidents')
  async listIncidents(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = limit ? Number.parseInt(limit, 10) : undefined;
    return this.incidentService.listIncidents({
      status,
      limit: Number.isFinite(parsed) ? parsed : undefined,
    });
  }

  @Get('incidents/:incidentId')
  async getIncident(@Param('incidentId') incidentId: string) {
    return this.incidentService.getIncident(incidentId);
  }

  @Get('incidents/:incidentId/postmortem')
  async getIncidentPostmortem(@Param('incidentId') incidentId: string) {
    const markdown = await this.incidentService.renderPostmortem(incidentId);
    return { incidentId, markdown };
  }

  private actor(req: OpsRequest): string {
    return req.apiKey?.name ?? req.apiKey?.id ?? 'unknown';
  }
}
