import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
  validateSync,
} from 'class-validator';
import { Type } from 'class-transformer';

import { OracleService } from './oracle.service';
import { SignatureGuard } from './guards/signature.guard';
import { AttestationService } from './attestation/attestation.service';
import {
  AttestationTier,
  TeeType,
} from './attestation/attestation.types';
import { MetricsService } from '../metrics/metrics.service';
import { EvidenceService } from '../evidence/evidence.service';

const MAX_QUOTE_BYTES = 64 * 1024;
const MAX_NONCE_LENGTH = 256;
const MAX_PAYLOAD_HASH_LENGTH = 128;

export class AttestationDto {
  @IsString()
  @IsIn(Object.values(TeeType))
  teeType!: TeeType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_QUOTE_BYTES)
  quote!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_NONCE_LENGTH)
  nonce!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_PAYLOAD_HASH_LENGTH)
  @Matches(/^[a-zA-Z0-9:_-]+$/)
  payloadHash!: string;
}

export class ProviderReadingDto {
  @IsString()
  @IsNotEmpty()
  sourceId!: string;

  @IsString()
  @IsNotEmpty()
  providerId!: string;

  @IsObject()
  reading!: Record<string, unknown>;

  @IsString()
  @IsNotEmpty()
  signature!: string;

  @IsString()
  @IsNotEmpty()
  nonce!: string;

  @IsOptional()
  @IsString()
  timestamp?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AttestationDto)
  attestation?: AttestationDto;
}

export interface ProviderSubmissionResult {
  accepted: boolean;
  submissionId: string;
  attestationTier: AttestationTier;
  policyVersion: string;
  attestationFailureReason?: string;
}

@Controller('oracle')
export class OracleController {
  private readonly logger = new Logger(OracleController.name);

  constructor(
    private readonly oracleService: OracleService,
    private readonly attestationService: AttestationService,
    private readonly metricsService: MetricsService,
    private readonly evidenceService: EvidenceService,
  ) {}

  @Post('provider/submit')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(SignatureGuard)
  async submitProviderReading(
    @Body() body: ProviderReadingDto,
    @Req() req: Request,
  ): Promise<ProviderSubmissionResult> {
    const validationErrors = validateSync(body, {
      whitelist: true,
      forbidNonWhitelisted: false,
    });
    if (validationErrors.length > 0) {
      throw new HttpException(
        {
          message: 'Invalid provider submission payload',
          errors: validationErrors.map((e) => ({
            property: e.property,
            constraints: e.constraints,
          })),
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const submissionId = await this.oracleService.recordSubmission(body);

    // Signature verification already ran in the guard. Attestation is a
    // separate, independently testable step that runs after signature
    // verification and before consensus weighting.
    const attestationOutcome = await this.attestationService.verify({
      submissionId,
      sourceId: body.sourceId,
      providerId: body.providerId,
      reading: body.reading,
      requestNonce: body.nonce,
      attestation: body.attestation,
    });

    let attestationTier: AttestationTier;
    let policyVersion: string;
    let attestationFailureReason: string | undefined;

    if (attestationOutcome.status === 'attested') {
      attestationTier = attestationOutcome.tier;
      policyVersion = attestationOutcome.policyVersion;
    } else if (attestationOutcome.status === 'unattested') {
      // No attestation object supplied: reading remains valid at base tier.
      attestationTier = AttestationTier.BASE;
      policyVersion = attestationOutcome.policyVersion;
    } else {
      // Attestation was claimed but failed verification. Never silently
      // downgrade to "unsigned ok" — record evidence with the specific
      // failure reason and keep the reading at the base tier.
      attestationTier = AttestationTier.BASE;
      policyVersion = attestationOutcome.policyVersion;
      attestationFailureReason = attestationOutcome.failureReason;

      await this.evidenceService.recordAttestationFailure({
        submissionId,
        sourceId: body.sourceId,
        providerId: body.providerId,
        teeType: body.attestation?.teeType,
        failureReason: attestationOutcome.failureReason,
        failureCode: attestationOutcome.failureCode,
        policyVersion,
        observedAt: new Date().toISOString(),
      });

      this.logger.warn(
        `Attestation failed for submission ${submissionId} (source=${body.sourceId}, provider=${body.providerId}): ${attestationOutcome.failureCode} - ${attestationOutcome.failureReason}`,
      );
    }

    await this.oracleService.persistAttestationTier({
      submissionId,
      attestationTier,
      policyVersion,
      failureReason: attestationFailureReason,
    });

    this.metricsService.incrementProviderSubmission({
      sourceId: body.sourceId,
      providerId: body.providerId,
      attestationTier,
      policyVersion,
      attestationFailed: attestationFailureReason !== undefined,
    });

    return {
      accepted: true,
      submissionId,
      attestationTier,
      policyVersion,
      ...(attestationFailureReason
        ? { attestationFailureReason }
        : {}),
    };
  }

  @Get('provider/attestation/policy')
  getAttestationPolicy(): {
    policyVersion: string;
    allowedTeeTypes: TeeType[];
    tiers: AttestationTier[];
  } {
    return {
      policyVersion: this.attestationService.getPolicyVersion(),
      allowedTeeTypes: this.attestationService.getAllowedTeeTypes(),
      tiers: [AttestationTier.BASE, AttestationTier.ATTESTED],
    };
  }
}