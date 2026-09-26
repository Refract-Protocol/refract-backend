import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Interval } from "@nestjs/schedule";
import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";
import { CursorOutsideRetentionWindowError } from "./cursor-outside-retention.error";
import { CapitalProvidedHandler } from "./handlers/capital-provided.handler";
import { CapitalWithdrawnHandler } from "./handlers/capital-withdrawn.handler";
import { ClaimProcessedHandler } from "./handlers/claim-processed.handler";
import {
  DecodedContractEvent,
  EVENT_TOPICS,
  extractEventTopicName,
} from "./handlers/event-types";
import { PolicyPurchasedHandler } from "./handlers/policy-purchased.handler";
import { DEFAULT_CURSOR_KEY, IndexerCursorRepository } from "./indexer-cursor.repository";

/**
 * Polls Soroban `getEvents` for Refract pool / policy / oracle contracts and
 * projects matching events into the off-chain DB.
 *
 * Assumed topic Symbol names (see handlers/* comments for payload shapes):
 *   policy_purchased | capital_provided | capital_withdrawn | claim_processed
 *
 * ⚠️ LEADER ELECTION: Only ONE replica must run this indexer. Concurrent
 * replicas race on `indexer_cursors` and can double-project before
 * `processed_events` idempotency settles. Elect a single leader (or run a
 * singleton Deployment / disable via EVENT_INDEXER_ENABLED=false on followers).
 */
export interface EventIndexerStatus {
  enabled: boolean;
  running: boolean;
  eventsProcessed: number;
  lagLedgers: number | null;
  lastProcessedAt: string | null;
  lastLedger: number;
  lastEventId: string;
  latestRpcLedger: number | null;
  retentionError: string | null;
  lagAlert: boolean;
}

/** Minimal RPC surface the indexer needs (easy to mock in unit tests). */
export interface EventIndexerRpc {
  getEvents(request: {
    filters: rpc.Api.EventFilter[];
    startLedger?: number;
    endLedger?: number;
    cursor?: string;
    limit?: number;
  }): Promise<{
    events: RawRpcEvent[];
    /** Present on newer RPCs / test mocks; stellar-sdk v12 types omit it. */
    cursor?: string;
    latestLedger?: number;
    oldestLedger?: number;
  }>;
  getLatestLedger?: () => Promise<{ sequence: number }>;
}

export interface RawRpcEvent {
  id: string;
  ledger: number | string;
  ledgerClosedAt?: string;
  contractId?: string | { contractId?: () => string; toString?: () => string };
  txHash?: string;
  topic?: xdr.ScVal[];
  value?: xdr.ScVal;
  /** stellar-sdk v12 paging token — used as the next-page cursor. */
  pagingToken?: string;
  /** Test helper: pre-decoded topic name (bypasses ScVal decode). */
  _topicName?: string;
  /** Test helper: pre-decoded value (bypasses ScVal decode). */
  _nativeValue?: unknown;
  /** Test helper: pre-decoded topics. */
  _nativeTopics?: unknown[];
}

export interface EventIndexerConfigSlice {
  enabled: boolean;
  pollIntervalMs: number;
  lagAlertLedgers: number;
  pageLimit: number;
  contractIds: string[];
}

@Injectable()
export class EventIndexerService {
  private readonly logger = new Logger(EventIndexerService.name);
  private server: EventIndexerRpc;
  private readonly cursorRepo: IndexerCursorRepository;
  private readonly policyPurchased: PolicyPurchasedHandler;
  private readonly capitalProvided: CapitalProvidedHandler;
  private readonly capitalWithdrawn: CapitalWithdrawnHandler;
  private readonly claimProcessed: ClaimProcessedHandler;
  private readonly cfg: EventIndexerConfigSlice;

  private running = false;
  private eventsProcessed = 0;
  private lastProcessedAt: Date | null = null;
  private lastLedger = 0;
  private lastEventId = "";
  private latestRpcLedger: number | null = null;
  private retentionError: string | null = null;
  private lastPollStartedAt = 0;

  constructor(
    configService: ConfigService<AppConfig, true>,
    cursorRepo: IndexerCursorRepository,
    policyPurchased: PolicyPurchasedHandler,
    capitalProvided: CapitalProvidedHandler,
    capitalWithdrawn: CapitalWithdrawnHandler,
    claimProcessed: ClaimProcessedHandler
  ) {
    const stellar = configService.get("stellar", { infer: true });
    const indexer = configService.get("eventIndexer", { infer: true });
    this.server = new rpc.Server(stellar.sorobanRpcUrl);
    this.cursorRepo = cursorRepo;
    this.policyPurchased = policyPurchased;
    this.capitalProvided = capitalProvided;
    this.capitalWithdrawn = capitalWithdrawn;
    this.claimProcessed = claimProcessed;
    this.cfg = {
      enabled: indexer.enabled,
      pollIntervalMs: indexer.pollIntervalMs,
      lagAlertLedgers: indexer.lagAlertLedgers,
      pageLimit: indexer.pageLimit,
      contractIds: [stellar.poolContractId, stellar.policyContractId, stellar.oracleContractId].filter(
        (id): id is string => Boolean(id && id.trim())
      ),
    };
  }

  /**
   * Build an indexer bound to in-memory fakes / a mocked RPC — used by unit
   * tests so they do not need Nest DI or Postgres.
   */
  static forTest(opts: {
    rpc: EventIndexerRpc;
    cursorRepo: IndexerCursorRepository;
    policyPurchased: PolicyPurchasedHandler;
    capitalProvided: CapitalProvidedHandler;
    capitalWithdrawn: CapitalWithdrawnHandler;
    claimProcessed: ClaimProcessedHandler;
    config?: Partial<EventIndexerConfigSlice>;
  }): EventIndexerService {
    const configService = {
      get: (key: string) => {
        if (key === "stellar") {
          return {
            sorobanRpcUrl: "https://example.test",
            poolContractId: opts.config?.contractIds?.[0] ?? "CPPOOL",
            policyContractId: opts.config?.contractIds?.[1] ?? "CPPLOY",
            oracleContractId: opts.config?.contractIds?.[2] ?? "CORACLE",
          };
        }
        if (key === "eventIndexer") {
          return {
            enabled: opts.config?.enabled ?? true,
            pollIntervalMs: opts.config?.pollIntervalMs ?? 5_000,
            lagAlertLedgers: opts.config?.lagAlertLedgers ?? 100,
            pageLimit: opts.config?.pageLimit ?? 100,
          };
        }
        return undefined;
      },
    } as unknown as ConfigService<AppConfig, true>;

    const svc = new EventIndexerService(
      configService,
      opts.cursorRepo,
      opts.policyPurchased,
      opts.capitalProvided,
      opts.capitalWithdrawn,
      opts.claimProcessed
    );
    svc.bindRpc(opts.rpc);
    if (opts.config?.contractIds) {
      svc.cfg.contractIds = opts.config.contractIds;
    }
    if (opts.config?.enabled != null) svc.cfg.enabled = opts.config.enabled;
    if (opts.config?.pageLimit != null) svc.cfg.pageLimit = opts.config.pageLimit;
    if (opts.config?.lagAlertLedgers != null) svc.cfg.lagAlertLedgers = opts.config.lagAlertLedgers;
    if (opts.config?.pollIntervalMs != null) svc.cfg.pollIntervalMs = opts.config.pollIntervalMs;
    return svc;
  }

  /** Swap the RPC client (tests). */
  bindRpc(server: EventIndexerRpc): void {
    this.server = server;
  }

  /**
   * Nest `@Interval` tick. Honours `eventIndexer.pollIntervalMs` via a
   * throttle so the config value is actually respected.
   */
  @Interval(1_000)
  async pollTick(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPollStartedAt < this.cfg.pollIntervalMs) {
      return;
    }
    this.lastPollStartedAt = now;
    await this.poll();
  }

  async poll(): Promise<void> {
    if (!this.cfg.enabled) {
      return;
    }
    if (this.cfg.contractIds.length === 0) {
      this.logger.debug("Event indexer skipped — no contract IDs configured");
      return;
    }
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.drainFromCursor();
    } catch (err) {
      if (err instanceof CursorOutsideRetentionWindowError) {
        this.retentionError = err.message;
        this.logger.error(err.message);
      } else {
        this.logger.error("Event indexer poll failed", err instanceof Error ? err.stack : err);
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * On-demand historical backfill over an inclusive ledger range. Idempotent
   * via `processed_events` — safe to run twice over the same range.
   */
  async backfill(fromLedger: number, toLedger: number): Promise<{ processed: number }> {
    if (fromLedger > toLedger) {
      throw new Error(`backfill fromLedger (${fromLedger}) must be <= toLedger (${toLedger})`);
    }
    if (this.cfg.contractIds.length === 0) {
      throw new Error("Cannot backfill: no contract IDs configured");
    }

    let processed = 0;
    const startLedger = fromLedger;
    let pageCursor: string | undefined;

    for (;;) {
      const response = await this.fetchPage({
        startLedger: pageCursor ? undefined : startLedger,
        cursor: pageCursor,
      });

      this.assertRetention(startLedger, response);
      this.latestRpcLedger = response.latestLedger ?? this.latestRpcLedger;

      const rawEvents = response.events ?? [];
      if (rawEvents.length === 0) {
        break;
      }

      const events = rawEvents.filter((e) => {
        const ledger = Number(e.ledger);
        return ledger >= fromLedger && ledger <= toLedger;
      });

      for (const raw of events) {
        const didProcess = await this.processRawEvent(raw);
        if (didProcess) {
          processed += 1;
        }
        await this.advanceCursor(Number(raw.ledger), raw.id);
      }

      // Stop once we've seen events past toLedger, or the page was short.
      const lastLedgerInPage = Number(rawEvents[rawEvents.length - 1].ledger);
      if (rawEvents.length < this.cfg.pageLimit || lastLedgerInPage > toLedger) {
        break;
      }
      pageCursor = nextPageCursor(response, rawEvents);
      if (!pageCursor) {
        break;
      }
    }

    return { processed };
  }

  getStatus(): EventIndexerStatus {
    const lag =
      this.latestRpcLedger != null ? Math.max(0, this.latestRpcLedger - this.lastLedger) : null;

    return {
      enabled: this.cfg.enabled,
      running: this.running,
      eventsProcessed: this.eventsProcessed,
      lagLedgers: lag,
      lastProcessedAt: this.lastProcessedAt ? this.lastProcessedAt.toISOString() : null,
      lastLedger: this.lastLedger,
      lastEventId: this.lastEventId,
      latestRpcLedger: this.latestRpcLedger,
      retentionError: this.retentionError,
      lagAlert: lag != null && lag >= this.cfg.lagAlertLedgers,
    };
  }

  private async drainFromCursor(): Promise<void> {
    const cursor = await this.cursorRepo.getCursor(DEFAULT_CURSOR_KEY);
    this.lastLedger = cursor.lastLedger;
    this.lastEventId = cursor.lastEventId;

    let startLedger = await this.resolveStartLedger(cursor.lastLedger);
    let pageCursor: string | undefined;
    let resume = { lastLedger: cursor.lastLedger, lastEventId: cursor.lastEventId };

    for (;;) {
      const response = await this.fetchPage({
        startLedger: pageCursor ? undefined : startLedger,
        cursor: pageCursor,
      });

      this.assertRetention(startLedger, response);
      this.latestRpcLedger = response.latestLedger ?? this.latestRpcLedger;
      this.retentionError = null;

      const events = response.events ?? [];
      if (events.length === 0) {
        break;
      }

      // Drain the page fully before considering it done. Cursor advances
      // per-event only after that event's handler succeeds; a throw stops
      // the loop without advancing past the failed event.
      for (const raw of events) {
        if (this.shouldSkipAlreadySeen(raw, resume)) {
          continue;
        }
        await this.processRawEvent(raw);
        await this.advanceCursor(Number(raw.ledger), raw.id);
        resume = { lastLedger: Number(raw.ledger), lastEventId: raw.id };
      }

      if (events.length < this.cfg.pageLimit) {
        break;
      }
      pageCursor = nextPageCursor(response, events);
      if (!pageCursor) {
        break;
      }
      startLedger = Number(events[events.length - 1].ledger);
    }
  }

  private async resolveStartLedger(cursorLedger: number): Promise<number> {
    if (cursorLedger > 0) {
      return cursorLedger;
    }
    // First run: start at the network tip so we don't walk the whole
    // retention window. Historical gaps are filled via backfill().
    if (this.server.getLatestLedger) {
      const latest = await this.server.getLatestLedger();
      return latest.sequence;
    }
    const probe = await this.fetchPage({ startLedger: 1 });
    if (probe.oldestLedger != null) {
      return probe.oldestLedger;
    }
    if (probe.latestLedger != null) {
      return probe.latestLedger;
    }
    return 1;
  }

  private shouldSkipAlreadySeen(
    raw: RawRpcEvent,
    cursor: { lastLedger: number; lastEventId: string }
  ): boolean {
    const ledger = Number(raw.ledger);
    if (cursor.lastLedger === 0 || !cursor.lastEventId) {
      return false;
    }
    if (ledger < cursor.lastLedger) {
      return true;
    }
    if (ledger > cursor.lastLedger) {
      return false;
    }
    return raw.id <= cursor.lastEventId;
  }

  /**
   * Handle → mark processed. Cursor advancement is the caller's responsibility
   * and must only happen after this resolves successfully.
   */
  private async processRawEvent(raw: RawRpcEvent): Promise<boolean> {
    const eventId = raw.id;

    if (await this.cursorRepo.hasProcessed(eventId)) {
      return false;
    }

    const topicName = raw._topicName ?? this.decodeTopicName(raw.topic ?? []);
    const nativeTopics = raw._nativeTopics ?? (raw.topic ?? []).map((t) => safeScValToNative(t));
    const nativeValue =
      raw._nativeValue !== undefined
        ? raw._nativeValue
        : raw.value != null
          ? safeScValToNative(raw.value)
          : null;

    if (topicName && isKnownTopic(topicName)) {
      const decoded: DecodedContractEvent = {
        eventId,
        ledger: Number(raw.ledger),
        ledgerClosedAt: raw.ledgerClosedAt ?? "",
        contractId: contractIdToString(raw.contractId),
        txHash: raw.txHash ?? "",
        topics: nativeTopics.length > 0 ? nativeTopics : [topicName],
        value: nativeValue,
      };
      // If the handler throws, we do NOT mark processed and do NOT advance
      // the cursor — the next poll retries this event.
      await this.dispatch(topicName, decoded);
    }

    await this.cursorRepo.tryMarkProcessed({
      eventId,
      ledger: Number(raw.ledger),
      topic: topicName ?? "unknown",
      contractId: contractIdToString(raw.contractId),
      txHash: raw.txHash,
    });

    this.eventsProcessed += 1;
    this.lastProcessedAt = new Date();
    return true;
  }

  private async dispatch(topicName: string, event: DecodedContractEvent): Promise<void> {
    switch (topicName) {
      case EVENT_TOPICS.POLICY_PURCHASED:
        await this.policyPurchased.handle(event);
        break;
      case EVENT_TOPICS.CAPITAL_PROVIDED:
        await this.capitalProvided.handle(event);
        break;
      case EVENT_TOPICS.CAPITAL_WITHDRAWN:
        await this.capitalWithdrawn.handle(event);
        break;
      case EVENT_TOPICS.CLAIM_PROCESSED:
        await this.claimProcessed.handle(event);
        break;
      default:
        this.logger.debug(`Ignoring unhandled topic ${topicName}`);
    }
  }

  private async advanceCursor(ledger: number, eventId: string): Promise<void> {
    await this.cursorRepo.saveCursor(ledger, eventId, DEFAULT_CURSOR_KEY);
    this.lastLedger = ledger;
    this.lastEventId = eventId;
    this.lastProcessedAt = new Date();
  }

  private async fetchPage(opts: {
    startLedger?: number;
    cursor?: string;
  }): Promise<{
    events: RawRpcEvent[];
    cursor?: string;
    latestLedger?: number;
    oldestLedger?: number;
  }> {
    const filters: rpc.Api.EventFilter[] = [
      {
        type: "contract",
        contractIds: this.cfg.contractIds,
      },
    ];

    try {
      if (opts.cursor) {
        return await this.server.getEvents({
          filters,
          cursor: opts.cursor,
          limit: this.cfg.pageLimit,
        });
      }
      return await this.server.getEvents({
        filters,
        startLedger: opts.startLedger!,
        limit: this.cfg.pageLimit,
      });
    } catch (err) {
      const mapped = mapRetentionRpcError(err, opts.startLedger ?? 0);
      if (mapped) throw mapped;
      throw err;
    }
  }

  private assertRetention(
    requestedStart: number,
    response: { oldestLedger?: number; latestLedger?: number }
  ): void {
    const oldest = response.oldestLedger;
    const latest = response.latestLedger ?? 0;
    if (oldest != null && requestedStart > 0 && requestedStart < oldest) {
      throw new CursorOutsideRetentionWindowError(requestedStart, oldest, latest);
    }
  }

  private decodeTopicName(topics: xdr.ScVal[]): string | null {
    const native = topics.map((t) => safeScValToNative(t));
    return extractEventTopicName(native);
  }
}

function nextPageCursor(
  response: { cursor?: string },
  events: RawRpcEvent[]
): string | undefined {
  if (response.cursor) {
    return response.cursor;
  }
  const last = events[events.length - 1];
  return last?.pagingToken ?? last?.id;
}

function isKnownTopic(name: string): boolean {
  return (Object.values(EVENT_TOPICS) as string[]).includes(name);
}

function safeScValToNative(val: xdr.ScVal): unknown {
  try {
    return scValToNative(val);
  } catch {
    return null;
  }
}

function contractIdToString(
  contractId?: string | { contractId?: () => string; toString?: () => string }
): string {
  if (!contractId) return "";
  if (typeof contractId === "string") return contractId;
  if (typeof contractId.contractId === "function") {
    try {
      return contractId.contractId();
    } catch {
      /* fall through */
    }
  }
  if (typeof contractId.toString === "function") {
    return contractId.toString();
  }
  return "";
}

function mapRetentionRpcError(err: unknown, cursorLedger: number): CursorOutsideRetentionWindowError | null {
  const message = err instanceof Error ? err.message : String(err);
  if (/startLedger|oldest ledger|retention|outside.*histor/i.test(message)) {
    const oldestMatch = message.match(/oldest(?:Ledger)?[^\d]*(\d+)/i);
    const latestMatch = message.match(/latest(?:Ledger)?[^\d]*(\d+)/i);
    return new CursorOutsideRetentionWindowError(
      cursorLedger,
      oldestMatch ? Number(oldestMatch[1]) : 0,
      latestMatch ? Number(latestMatch[1]) : 0
    );
  }
  return null;
}
