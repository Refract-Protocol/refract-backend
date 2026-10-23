import { Type } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { HoldDisposition, SignatureStatus, SourceStatus } from "../evidence.types";

export class RegisterSourceDto {
  @IsString() @IsNotEmpty() @MaxLength(80) sourceId!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) providerId!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) feedId!: string;
  @IsOptional() @IsIn(["active", "warmup", "quarantined"]) status?: Exclude<SourceStatus, "retired">;
  @IsNumber() @Min(0) weight!: number;
  @IsOptional() @IsInt() @Min(0) warmupMs?: number;
  @IsInt() @Min(0) retentionDays!: number;
  @IsOptional() @IsString() @MaxLength(200) credentialRef?: string;
  @IsOptional() @IsString() @MaxLength(200) declaredUpstream?: string;
}

class TriggerRuleDto {
  @IsIn(["lt", "gt"]) op!: "lt" | "gt";
  @IsNumber() threshold!: number;
}

export class SetQuorumPolicyDto {
  @IsString() @IsNotEmpty() @MaxLength(80) feedId!: string;
  @IsInt() @Min(1) minSources!: number;
  @IsOptional() @IsInt() @Min(1) expectedSources?: number;
  @IsNumber() @Min(0) minTotalWeight!: number;
  @IsInt() @Min(1) maxReadingAgeMs!: number;
  @ValidateNested() @Type(() => TriggerRuleDto) trigger!: TriggerRuleDto;
}

export class RecordReadingDto {
  @IsString() @IsNotEmpty() @MaxLength(80) feedId!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) sourceId!: string;
  @IsNumber() value!: number;
  @IsInt() observedAt!: number;
  @IsOptional() @IsInt() @Min(0) ledgerSeq?: number;
  @IsOptional() @IsString() @MaxLength(1_000_000) rawPayload?: string;
  @IsOptional() @IsIn(["verified", "pending", "failed", "not_required"]) signature?: SignatureStatus;
}

export class SignatureResultDto {
  @IsIn(["verified", "failed"]) result!: "verified" | "failed";
}

export class HoldDispositionDto {
  @IsIn(["approve_payout", "deny", "extend_hold"]) disposition!: HoldDisposition;
  @IsString() @IsNotEmpty() @MaxLength(120) actor!: string;
  @IsString() @IsNotEmpty() @MaxLength(2000) note!: string;
  @IsOptional() @IsInt() @Min(1) extendMs?: number;
}

export class OffboardSourceDto {
  @IsString() @IsNotEmpty() @MaxLength(120) actor!: string;
  @IsString() @IsNotEmpty() @MaxLength(2000) reason!: string;
  @IsOptional() @IsBoolean() dryRun?: boolean;
  @IsOptional() @IsBoolean() acknowledgeQuorumLoss?: boolean;
}
