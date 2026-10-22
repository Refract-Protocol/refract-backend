import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  NotFoundException,
  BadRequestException,
  UseGuards,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { OracleService } from './oracle.service';
import { MethodologyService } from './methodology.service';
import { IncidentService } from '../services/incidentService';
import { AuthGuard } from '../auth/auth.guard';
import { ScopesGuard } from '../auth/scopes.guard';
import { Scopes } from '../auth/scopes.decorator';
import { AuditService } from '../services/auditService';

interface CreateMethodologyDto {
  sourceId: string;
  derivationDescription: string;
  samplingUniverse: string;
  revisionPolicy: string;
  expectedLatencyMs: number;
  knownFailureModes: string[];
  independenceWeight?: number;
  approved?: boolean;
  signOff?: {
    approvedBy?: string;
    reviewedBy?: string;
    approvedAt?: string;
  };
}

interface ApproveMethodologyDto {
  approvedBy: string;
  reviewedBy: string;
  notes?: string;
}

@Controller()
export class OracleController {
  constructor(
    private readonly oracleService: OracleService,
    private readonly methodologyService: MethodologyService,
    private readonly incidentService: IncidentService,
    private readonly auditService: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Public trust / provenance surface
  // ---------------------------------------------------------------------------

  /**
   * GET /api/v1/oracle/feeds/:feed/methodology
   *
   * Public trust/provenance endpoint. Returns the methodology version(s)
   * currently referenced by the feed's latest consensus decision, so that
   * point-in-time reconstruction resolves the exact semantics used.
   */
  @Get('api/v1/oracle/feeds/:feed/methodology')
  async getFeedMethodology(@Param('feed') feed: string) {
    const feedInfo = await this.oracleService.getFeed(feed);
    if (!feedInfo) {
      throw new NotFoundException(`Feed not found: ${feed}`);
    }

    const methodology = await this.methodologyService.getMethodologyForFeed(feed);
    if (!methodology) {
      throw new NotFoundException(`No methodology recorded for feed: ${feed}`);
    }

    return {
      feed,
      methodology,
    };
  }

  // ---------------------------------------------------------------------------
  // Operator: methodology management
  // ---------------------------------------------------------------------------

  /**
   * GET /api/v1/ops/oracle/sources/:id/methodology
   *
   * Returns the full methodology version history for a source, plus the
   * currently active version.
   */
  @Get('api/v1/ops/oracle/sources/:id/methodology')
  @UseGuards(AuthGuard, ScopesGuard)
  @Scopes('oracle:read')
  async getSourceMethodology(@Param('id') sourceId: string) {
    const history = await this.methodologyService.getMethodologyHistory(sourceId);
    if (!history || history.length === 0) {
      throw new NotFoundException(`No methodology recorded for source: ${sourceId}`);
    }

    const active = await this.methodologyService.getActiveMethodology(sourceId);

    return {
      sourceId,
      activeVersion: active ? active.version : null,
      active,
      history,
    };
  }

  /**
   * POST /api/v1/ops/oracle/sources/:id/methodology
   *
   * Creates a new immutable methodology version for a source. If `approved`
   * is true and sign-off flags are present, the new version becomes the
   * active version and the source may be activated. Audit entries are
   * recorded for every approval.
   */
  @Post('api/v1/ops/oracle/sources/:id/methodology')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AuthGuard, ScopesGuard)
  @Scopes('oracle:write')
  async createSourceMethodology(
    @Param('id') sourceId: string,
    @Body() body: CreateMethodologyDto,
    @Req() req: Request,
  ) {
    if (body.sourceId && body.sourceId !== sourceId) {
      throw new BadRequestException(
        `Path source id (${sourceId}) does not match body sourceId (${body.sourceId})`,
      );
    }

    const validation = this.methodologyService.validateMethodologyRecord({
      sourceId,
      derivationDescription: body.derivationDescription,
      samplingUniverse: body.samplingUniverse,
      revisionPolicy: body.revisionPolicy,
      expectedLatencyMs: body.expectedLatencyMs,
      knownFailureModes: body.knownFailureModes,
    });

    if (!validation.valid) {
      throw new BadRequestException({
        message: 'Incomplete methodology record',
        errors: validation.errors,
      });
    }

    const approved = body.approved === true;
    if (approved) {
      const signOff = body.signOff || {};
      if (!signOff.approvedBy || !signOff.reviewedBy) {
        throw new BadRequestException(
          'Approval requires explicit sign-off flags: approvedBy and reviewedBy',
        );
      }
    }

    const record = await this.methodologyService.createMethodologyVersion({
      sourceId,
      derivationDescription: body.derivationDescription,
      samplingUniverse: body.samplingUniverse,
      revisionPolicy: body.revisionPolicy,
      expectedLatencyMs: body.expectedLatencyMs,
      knownFailureModes: body.knownFailureModes,
      independenceWeight: body.independenceWeight,
      approved,
      signOff: body.signOff,
    });

    if (approved) {
      await this.auditService.record({
        action: 'oracle.methodology.approve',
        actor: (req as any).user?.id ?? 'unknown',
        targetType: 'oracle_source',
        targetId: sourceId,
        metadata: {
          methodologyId: record.id,
          version: record.version,
          approvedBy: body.signOff?.approvedBy,
          reviewedBy: body.signOff?.reviewedBy,
        },
      });
    } else {
      await this.auditService.record({
        action: 'oracle.methodology.create',
        actor: (req as any).user?.id ?? 'unknown',
        targetType: 'oracle_source',
        targetId: sourceId,
        metadata: {
          methodologyId: record.id,
          version: record.version,
        },
      });
    }

    return record;
  }

  /**
   * POST /api/v1/ops/oracle/sources/:id/methodology/:version/approve
   *
   * Approves an existing (draft) methodology version with explicit sign-off
   * flags, making it the active version for the source.
   */
  @Post('api/v1/ops/oracle/sources/:id/methodology/:version/approve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard, ScopesGuard)
  @Scopes('oracle:write')
  async approveSourceMethodology(
    @Param('id') sourceId: string,
    @Param('version') version: string,
    @Body() body: ApproveMethodologyDto,
    @Req() req: Request,
  ) {
    if (!body.approvedBy || !body.reviewedBy) {
      throw new BadRequestException(
        'Approval requires explicit sign-off flags: approvedBy and reviewedBy',
      );
    }

    const versionNum = Number(version);
    if (!Number.isInteger(versionNum) || versionNum <= 0) {
      throw new BadRequestException(`Invalid methodology version: ${version}`);
    }

    const record = await this.methodologyService.approveMethodologyVersion({
      sourceId,
      version: versionNum,
      approvedBy: body.approvedBy,
      reviewedBy: body.reviewedBy,
      notes: body.notes,
    });

    if (!record) {
      throw new NotFoundException(
        `Methodology version ${version} not found for source: ${sourceId}`,
      );
    }

    await this.auditService.record({
      action: 'oracle.methodology.approve',
      actor: (req as any).user?.id ?? 'unknown',
      targetType: 'oracle_source',
      targetId: sourceId,
      metadata: {
        methodologyId: record.id,
        version: record.version,
        approvedBy: body.approvedBy,
        reviewedBy: body.reviewedBy,
        notes: body.notes,
      },
    });

    return record;
  }

  // ---------------------------------------------------------------------------
  // Operator: incidents and postmortems
  // ---------------------------------------------------------------------------

  /**
   * GET /api/v1/ops/incidents
   *
   * Lists incidents, optionally filtered by feed, status, or trigger class.
   */
  @Get('api/v1/ops/incidents')
  @UseGuards(AuthGuard, ScopesGuard)
  @Scopes('oracle:read')
  async listIncidents(
    @Query('feed') feed?: string,
    @Query('status') status?: string,
    @Query('trigger') trigger?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const parsedLimit = limit ? Number(limit) : undefined;
    if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
      throw new BadRequestException(`Invalid limit: ${limit}`);
    }

    return this.incidentService.listIncidents({
      feed,
      status,
      triggerClass: trigger,
      limit: parsedLimit,
      cursor,
    });
  }

  /**
   * GET /api/v1/ops/incidents/:id/postmortem
   *
   * Renders the draft postmortem (markdown) for an incident from its stored
   * event timeline. Rendering is deterministic and cached by incident version.
   */
  @Get('api/v1/ops/incidents/:id/postmortem')
  @UseGuards(AuthGuard, ScopesGuard)
  @Scopes('oracle:read')
  async getIncidentPostmortem(@Param('id') incidentId: string) {
    const incident = await this.incidentService.getIncident(incidentId);
    if (!incident) {
      throw new NotFoundException(`Incident not found: ${incidentId}`);
    }

    const postmortem = await this.incidentService.renderPostmortem(incidentId);
    if (!postmortem) {
      throw new NotFoundException(`Postmortem not available for incident: ${incidentId}`);
    }

    return {
      incidentId,
      version: incident.version,
      status: incident.status,
      triggerClass: incident.triggerClass,
      openedAt: incident.openedAt,
      closedAt: incident.closedAt,
      markdown: postmortem.markdown,
      generatedAt: postmortem.generatedAt,
    };
  }
}