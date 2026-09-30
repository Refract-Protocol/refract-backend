import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Interval } from "@nestjs/schedule";
import { Pool, PoolClient } from "pg";
import { scValToNative } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { SorobanRpcClient } from "../stellar/soroban-rpc.client";

const POLL_INTERVAL_MS = 10_000;
const EVENT_PAGE_SIZE = 100;

type PoolEventType = "POLICY_PURCHASED" | "CAPITAL_PROVIDED" | "CAPITAL_WITHDRAWN" | "CLAIM_SETTLED";

export interface NormalizedPoolEvent {
  eventId: string;
  cursor: string;
  contractId: string;
  eventType: PoolEventType;
  ledger: number;
  txHash: string;
  ledgerClosedAt: string;
  holder: string | null;
  policyId: string | null;
  amount: string | null;
  secondaryAmount: string | null;
  expiresAt: string | null;
  payload: string;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return value.toString();
  }
  throw new Error(`Unexpected ${field} value in pool contract event`);
}

function tupleValue(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Unexpected ${field} tuple in pool contract event`);
  return value;
}

function serializeEventValue(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item));
}

export function normalizePoolEvent(event: {
  id: string;
  contractId?: { toString(): string };
  topic: Array<Parameters<typeof scValToNative>[0]>;
  value: Parameters<typeof scValToNative>[0];
  ledger: number;
  txHash: string;
  ledgerClosedAt: string;
  pagingToken: string;
}): NormalizedPoolEvent | null {
  if (!event.contractId || event.topic.length === 0) return null;

  const name = scValToNative(event.topic[0]);
  const eventTypes: Record<string, PoolEventType> = {
    BUY: "POLICY_PURCHASED",
    PROVIDE: "CAPITAL_PROVIDED",
    WITHDRAW: "CAPITAL_WITHDRAWN",
    CLAIM: "CLAIM_SETTLED",
  };
  if (typeof name !== "string" || !(name in eventTypes)) return null;

  const eventType = eventTypes[name];
  const holder = event.topic.length > 1 ? stringValue(scValToNative(event.topic[1]), "holder") : null;
  const payload = tupleValue(scValToNative(event.value), "event payload");

  let policyId: string | null = null;
  let amount: string | null = null;
  let secondaryAmount: string | null = null;
  let expiresAt: string | null = null;

  switch (eventType) {
    case "POLICY_PURCHASED":
      [policyId, amount, secondaryAmount, expiresAt] = [
        stringValue(payload[0], "policy id"),
        stringValue(payload[1], "coverage amount"),
        stringValue(payload[2], "premium"),
        stringValue(payload[3], "policy expiry"),
      ];
      break;
    case "CAPITAL_PROVIDED":
      [amount, secondaryAmount] = [
        stringValue(payload[0], "provided amount"),
        stringValue(payload[1], "shares minted"),
      ];
      break;
    case "CAPITAL_WITHDRAWN":
      [amount, secondaryAmount] = [
        stringValue(payload[0], "shares burned"),
        stringValue(payload[1], "withdrawn amount"),
      ];
      break;
    case "CLAIM_SETTLED":
      [policyId, amount] = [stringValue(payload[0], "policy id"), stringValue(payload[1], "claim payout")];
      break;
  }

  return {
    eventId: event.id,
    cursor: event.pagingToken,
    contractId: event.contractId.toString(),
    eventType,
    ledger: event.ledger,
    txHash: event.txHash,
    ledgerClosedAt: event.ledgerClosedAt,
    holder,
    policyId,
    amount,
    secondaryAmount,
    expiresAt,
    payload: serializeEventValue({
      topics: event.topic.map((topic) => scValToNative(topic)),
      value: payload,
    }),
  };
}

@Injectable()
export class PoolEventIngestionService implements OnModuleDestroy {
  private readonly logger = new Logger(PoolEventIngestionService.name);
  private readonly pool: Pool;
  private readonly rpcClient: SorobanRpcClient;
  private readonly poolContractId: string;
  private readonly startLedger: number;
  private polling = false;

  constructor(configService: ConfigService<AppConfig, true>) {
    const stellar = configService.get("stellar", { infer: true });
    this.pool = new Pool({ connectionString: configService.get("database.url", { infer: true }) });
    this.rpcClient = new SorobanRpcClient(stellar.sorobanRpcUrls);
    this.poolContractId = stellar.poolContractId;
    this.startLedger = stellar.eventStartLedger;
    if (!this.poolContractId) {
      this.logger.warn("Pool event ingestion is disabled until REFRACT_POOL_CONTRACT_ID is configured");
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  @Interval(POLL_INTERVAL_MS)
  async pollPoolEvents(): Promise<void> {
    if (this.polling || !this.poolContractId) return;
    this.polling = true;
    try {
      await this.ingestNextPage();
    } catch (error) {
      this.logger.error("Failed to poll pool contract events", error instanceof Error ? error.stack : String(error));
    } finally {
      this.polling = false;
    }
  }

  private async ingestNextPage(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO soroban_event_cursors (contract_id, next_start_ledger)
         VALUES ($1, $2)
         ON CONFLICT (contract_id) DO NOTHING`,
        [this.poolContractId, this.startLedger]
      );
      const cursorResult = await client.query<{ cursor: string | null; next_start_ledger: string }>(
        `SELECT cursor, next_start_ledger
         FROM soroban_event_cursors
         WHERE contract_id = $1
         FOR UPDATE`,
        [this.poolContractId]
      );
      const checkpoint = cursorResult.rows[0];
      if (!checkpoint) throw new Error("Failed to load the pool event ingestion cursor");

      const response = await this.rpcClient.call((server) =>
        server.getEvents({
          filters: [{ type: "contract", contractIds: [this.poolContractId] }],
          limit: EVENT_PAGE_SIZE,
          ...(checkpoint.cursor
            ? { cursor: checkpoint.cursor }
            : { startLedger: Number(checkpoint.next_start_ledger) }),
        })
      );

      for (const event of response.events) {
        const normalized = normalizePoolEvent(event);
        if (normalized) await this.insertEvent(client, normalized);
      }

      const isFullPage = response.events.length === EVENT_PAGE_SIZE;
      const nextCursor = isFullPage ? response.events[response.events.length - 1].pagingToken : null;
      const nextStartLedger = isFullPage ? Number(checkpoint.next_start_ledger) : response.latestLedger + 1;
      await client.query(
        `UPDATE soroban_event_cursors
         SET cursor = $2, next_start_ledger = $3, updated_at = NOW()
         WHERE contract_id = $1`,
        [this.poolContractId, nextCursor, nextStartLedger]
      );
      await client.query("COMMIT");

      if (response.events.length > 0) {
        this.logger.log(
          `Ingested ${response.events.length} pool contract event(s) through ledger ${response.latestLedger}`
        );
      }
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertEvent(client: PoolClient, event: NormalizedPoolEvent): Promise<void> {
    await client.query(
      `INSERT INTO soroban_pool_events (
         event_id, cursor, contract_id, event_type, ledger, tx_hash, ledger_closed_at,
         holder, on_chain_policy_id, amount, secondary_amount, expires_at, payload
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
       ON CONFLICT (contract_id, event_id) DO NOTHING`,
      [
        event.eventId,
        event.cursor,
        event.contractId,
        event.eventType,
        event.ledger,
        event.txHash,
        event.ledgerClosedAt,
        event.holder,
        event.policyId,
        event.amount,
        event.secondaryAmount,
        event.expiresAt,
        event.payload,
      ]
    );
  }
}
