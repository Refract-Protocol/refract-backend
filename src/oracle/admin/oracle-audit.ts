import { AsyncLocalStorage } from "node:async_hooks";
import * as winston from "winston";
import { OracleRole } from "./operator-identity";

/**
 * Request-scoped audit identity. The operator guard authenticates the
 * caller, and an interceptor runs the handler inside this context. Code
 * further down (the control registry, the bootstrap service) can then stamp
 * changes with the real actor without passing it through every call.
 */
export interface AuditContext {
  requestId: string;
  actor: string;
  role: OracleRole;
  keyId: string;
  ip: string;
  /** Before/after records added by the code that made the change. */
  changes: AuditChange[];
}

export interface AuditChange {
  entity: string;
  id: string;
  before: unknown;
  after: unknown;
}

const storage = new AsyncLocalStorage<AuditContext>();

export function runWithAuditContext<T>(context: AuditContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentAuditContext(): AuditContext | undefined {
  return storage.getStore();
}

/** The acting operator, or `system` outside an operator request (startup seeding, schedulers). */
export function currentActor(): string {
  return storage.getStore()?.actor ?? "system";
}

export function recordAuditChange(change: AuditChange): void {
  storage.getStore()?.changes.push(change);
}

export type AuditOutcome = "success" | "denied" | "failure";

export interface OracleAuditEvent {
  event: "oracle_operator_audit";
  timestamp: string;
  requestId: string;
  action: string;
  method: string;
  route: string;
  statusCode: number;
  outcome: AuditOutcome;
  /** Why a request was denied or failed. Never contains credential material. */
  reason?: string;
  actor: {
    id: string;
    role?: OracleRole;
    keyId?: string;
    ip: string;
  };
  target: Record<string, string>;
  changes: AuditChange[];
}

export interface AuditSink {
  write(event: OracleAuditEvent): void;
}

export class WinstonAuditSink implements AuditSink {
  private readonly logger = winston.createLogger({
    level: "info",
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    transports: [new winston.transports.Console()],
  });

  write(event: OracleAuditEvent): void {
    this.logger.info(event);
  }
}

/**
 * Writes operator audit events to the configured sink (structured JSON logs
 * by default, for shipping to durable storage). It also keeps the most
 * recent events in memory so admins can read them through the API.
 */
export class OracleAuditLog {
  private readonly recent: OracleAuditEvent[] = [];

  constructor(
    private readonly sink: AuditSink = new WinstonAuditSink(),
    private readonly capacity = 1_000
  ) {}

  write(event: OracleAuditEvent): void {
    this.recent.push(event);
    if (this.recent.length > this.capacity) this.recent.splice(0, this.recent.length - this.capacity);
    this.sink.write(event);
  }

  /** Most recent first. */
  list(limit = 100): OracleAuditEvent[] {
    return this.recent.slice(-Math.max(0, limit)).reverse();
  }
}
