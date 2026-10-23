import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BASE_FEE, Contract, Keypair, TransactionBuilder, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { pollForConfirmation } from "../stellar/soroban-confirmation.util";
import { OracleReading } from "./oracle-reading";
import { coverageTypeToU32, scaleOracleValue } from "./oracle-encoding";

export interface OraclePublishRecord {
  coverageType: string;
  scaledValue: string;
  txHash?: string;
  confirmed: boolean;
  outcome?: string;
  error?: string;
  attemptedAt: number;
}

/**
 * Relayer path that pushes oracle readings to RefractOracle via
 * `update_reading(coverage_type: u32, value: i128)`.
 *
 * Mirrors ClaimSettlementService's build/prepare/sign/send/poll structure.
 * Degraded fail-safe readings are never published — treating an outage
 * placeholder as authoritative on-chain data would be a safety failure.
 */
@Injectable()
export class OraclePublisherService {
  private readonly logger = new Logger(OraclePublisherService.name);
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly oracleContractId: string;
  private readonly relayerKeypair: Keypair | null;
  private readonly publishMode: AppConfig["oraclePublish"]["mode"];
  private readonly minIntervalMs: number;
  private readonly confirmationDefaults: AppConfig["confirmation"];

  private readonly lastScaled = new Map<string, bigint>();
  private readonly lastPublishedAt = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly auditLog: OraclePublishRecord[] = [];

  constructor(private readonly configService: ConfigService<AppConfig, true>) {
    const stellar = this.configService.get("stellar", { infer: true });
    this.server = new rpc.Server(stellar.sorobanRpcUrl);
    this.networkPassphrase = stellar.networkPassphrase;
    this.oracleContractId = stellar.oracleContractId;
    this.relayerKeypair = stellar.relayerSecret ? Keypair.fromSecret(stellar.relayerSecret) : null;
    const publish = this.configService.get("oraclePublish", { infer: true });
    this.publishMode = publish.mode;
    this.minIntervalMs = publish.minIntervalMs;
    this.confirmationDefaults = this.configService.get("confirmation", { infer: true });
  }

  /** True once an oracle contract ID and relayer secret are configured. */
  isConfigured(): boolean {
    return Boolean(this.oracleContractId && this.relayerKeypair);
  }

  getAuditLog(): readonly OraclePublishRecord[] {
    return this.auditLog;
  }

  /**
   * Decide whether to publish and, if so, submit. Never throws — degrades
   * with a clear log when unconfigured (same posture as ClaimSettlementService).
   */
  async maybePublish(reading: OracleReading): Promise<OraclePublishRecord | null> {
    if (reading.degraded) {
      this.logger.warn(`Skipping on-chain publish for degraded ${reading.coverageType} reading`);
      return null;
    }

    if (!this.isConfigured()) {
      this.logger.debug(
        "Oracle publisher not configured (missing REFRACT_ORACLE_CONTRACT_ID or ORACLE_RELAYER_SECRET) — skipping"
      );
      return null;
    }

    let scaled: bigint;
    try {
      scaled = scaleOracleValue(reading.coverageType, reading.value);
    } catch (err) {
      this.logger.error(
        `Cannot scale oracle reading for ${reading.coverageType}`,
        err instanceof Error ? err.message : String(err)
      );
      return null;
    }

    const now = Date.now();
    const lastAt = this.lastPublishedAt.get(reading.coverageType) ?? 0;
    if (now - lastAt < this.minIntervalMs) {
      return null;
    }

    if (this.publishMode === "on_change") {
      const prev = this.lastScaled.get(reading.coverageType);
      if (prev !== undefined && prev === scaled) {
        return null;
      }
    }

    if (this.inFlight.has(reading.coverageType)) {
      this.logger.warn(`Overlapping publish suppressed for ${reading.coverageType}`);
      return null;
    }

    this.inFlight.add(reading.coverageType);
    try {
      const record = await this.publish(reading.coverageType, scaled);
      this.auditLog.push(record);
      if (this.auditLog.length > 500) this.auditLog.shift();
      if (record.confirmed) {
        this.lastScaled.set(reading.coverageType, scaled);
        this.lastPublishedAt.set(reading.coverageType, Date.now());
      }
      return record;
    } finally {
      this.inFlight.delete(reading.coverageType);
    }
  }

  private async publish(coverageType: string, scaledValue: bigint): Promise<OraclePublishRecord> {
    const attemptedAt = Date.now();
    const base: OraclePublishRecord = {
      coverageType,
      scaledValue: scaledValue.toString(10),
      confirmed: false,
      attemptedAt,
    };

    try {
      const sourceAccount = await this.server.getAccount(this.relayerKeypair!.publicKey());
      const contract = new Contract(this.oracleContractId);
      // RefractOracle.update_reading(coverage_type: u32, value: i128)
      const operation = contract.call(
        "update_reading",
        nativeToScVal(coverageTypeToU32(coverageType), { type: "u32" }),
        nativeToScVal(scaledValue, { type: "i128" })
      );

      const builtTx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const preparedTx = await this.server.prepareTransaction(builtTx);
      preparedTx.sign(this.relayerKeypair!);

      const sendResult = await this.server.sendTransaction(preparedTx);
      if (sendResult.status === "ERROR" || sendResult.status === "TRY_AGAIN_LATER") {
        const record = {
          ...base,
          txHash: sendResult.hash,
          error: `Submission not accepted: ${sendResult.status}`,
        };
        this.logger.error(`Oracle publish rejected for ${coverageType}: ${record.error}`);
        return record;
      }

      const confirmation = await pollForConfirmation(this.server, sendResult.hash, {
        initialIntervalMs: this.confirmationDefaults.initialIntervalMs,
        backoffMultiplier: this.confirmationDefaults.backoffMultiplier,
        maxIntervalMs: this.confirmationDefaults.maxIntervalMs,
        jitterRatio: this.confirmationDefaults.jitterRatio,
        deadlineMs: this.confirmationDefaults.settlementDeadlineMs,
      });

      const record: OraclePublishRecord = {
        ...base,
        txHash: confirmation.txHash,
        confirmed: confirmation.confirmed,
        outcome: confirmation.outcome,
        error: confirmation.error,
      };
      if (!record.confirmed) {
        this.logger.error(
          `Oracle publish did not confirm for ${coverageType}: outcome=${confirmation.outcome} error=${confirmation.error}`
        );
      } else {
        this.logger.log(`Oracle publish confirmed for ${coverageType}: tx=${confirmation.txHash} value=${scaledValue}`);
      }
      return record;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Oracle publish failed for ${coverageType}`, message);
      return { ...base, error: message };
    }
  }
}
