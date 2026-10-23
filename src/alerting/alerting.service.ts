import { Injectable, Logger, Optional } from "@nestjs/common";

export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertEvent {
  severity: AlertSeverity;
  title: string;
  message: string;
  context?: Record<string, unknown>;
  at: string;
}

/**
 * Minimal alerting sink — logs critically and keeps an in-memory ring buffer
 * for ops endpoints. Swap for PagerDuty/Slack later without changing callers.
 */
@Injectable()
export class AlertingService {
  private readonly logger = new Logger(AlertingService.name);
  private readonly recent: AlertEvent[] = [];
  private readonly maxRecent = 100;

  emit(severity: AlertSeverity, title: string, message: string, context?: Record<string, unknown>): void {
    const event: AlertEvent = {
      severity,
      title,
      message,
      context,
      at: new Date().toISOString(),
    };
    this.recent.unshift(event);
    if (this.recent.length > this.maxRecent) this.recent.pop();

    const line = `[${severity}] ${title}: ${message}`;
    if (severity === "critical") this.logger.error(line, JSON.stringify(context ?? {}));
    else if (severity === "warning") this.logger.warn(line);
    else this.logger.log(line);
  }

  listRecent(limit = 50): AlertEvent[] {
    return this.recent.slice(0, limit);
  }
}

// ---------------------------------------------------------------------------
// Alert routing layer (issue #289)
//
// Pipeline: emit -> fingerprint -> dedupe/group -> route -> escalate -> resolve
//
// The routing layer sits in front of AlertingService. Raw alerts are
// fingerprinted (feedId + alertClass + source, excluding volatile fields),
// deduplicated within a configurable window, grouped into a single incident
// per feed outage, routed by severity (page vs ticket), and driven through an
// explicit state machine (open -> acknowledged -> escalated -> resolved).
//
// Delivery is pluggable via the Notifier interface. Persistence is pluggable
// via the IncidentStore interface so a restart does not re-page or lose open
// incidents. Routing failures are swallowed (and logged) so that alerting
// never blocks the ingestion or settlement path.
// ---------------------------------------------------------------------------

export type AlertClass =
  | "staleness"
  | "divergence"
  | "quorum"
  | "anomaly"
  | "degraded"
  | "other";

export type AlertSource = "metrics" | "anomaly" | "oracle" | "manual" | string;

export type RoutingSeverity = "page" | "ticket" | "info";

export type IncidentState = "open" | "acknowledged" | "escalated" | "resolved";

export type IncidentTransition =
  | "opened"
  | "deduped"
  | "grouped"
  | "notified"
  | "acknowledged"
  | "renotified"
  | "escalated"
  | "resolved"
  | "auto_resolved";

export interface RawAlert {
  feedId: string;
  alertClass: AlertClass;
  source: AlertSource;
  severity?: AlertSeverity;
  title: string;
  message: string;
  /** Whether the underlying condition is payout-triggering (divergence). */
  payoutTriggering?: boolean;
  /** True when the alert indicates the underlying condition has cleared. */
  resolved?: boolean;
  context?: Record<string, unknown>;
  at?: string;
}

export interface IncidentTimelineEntry {
  at: string;
  transition: IncidentTransition;
  detail?: string;
  actor?: string;
}

export interface Incident {
  id: string;
  fingerprint: string;
  feedId: string;
  alertClass: AlertClass;
  source: AlertSource;
  severity: RoutingSeverity;
  state: IncidentState;
  title: string;
  message: string;
  context?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastNotifiedAt?: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  escalatedAt?: string;
  resolvedAt?: string;
  notificationCount: number;
  timeline: IncidentTimelineEntry[];
}

export interface Notifier {
  readonly name: string;
  notify(incident: Incident, transition: IncidentTransition): Promise<void> | void;
}

export interface IncidentStore {
  loadOpen(): Promise<Incident[]>;
  save(incident: Incident): Promise<void>;
}

export interface AuditLog {
  record(entry: {
    incidentId: string;
    feedId: string;
    transition: IncidentTransition;
    state: IncidentState;
    at: string;
    detail?: string;
    actor?: string;
  }): Promise<void> | void;
}

export interface RoutingConfig {
  /** Window in ms during which duplicate fingerprints are collapsed. */
  dedupWindowMs: number;
  /** Delay in ms before an unacknowledged incident is re-notified. */
  renotifyDelayMs: number;
  /** Delay in ms before an unacknowledged incident escalates to secondary on-call. */
  escalationDelayMs: number;
  /** Max notifications per incident (bounds storm volume). */
  maxNotificationsPerIncident: number;
  /** Max incidents created per dedup window across all feeds (storm guard). */
  maxIncidentsPerWindow: number;
}

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  dedupWindowMs: 5 * 60 * 1000,
  renotifyDelayMs: 10 * 60 * 1000,
  escalationDelayMs: 20 * 60 * 1000,
  maxNotificationsPerIncident: 5,
  maxIncidentsPerWindow: 50,
};

/** Clock abstraction so tests can inject a fake clock. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** In-memory store used as the default when no persistent store is wired. */
export class InMemoryIncidentStore implements IncidentStore {
  private readonly incidents = new Map<string, Incident>();

  async loadOpen(): Promise<Incident[]> {
    return [...this.incidents.values()].filter((i) => i.state !== "resolved");
  }

  async save(incident: Incident): Promise<void> {
    this.incidents.set(incident.id, { ...incident, timeline: [...incident.timeline] });
  }
}

/** Default notifier that simply logs — swap for PagerDuty/Slack adapters. */
export class LogNotifier implements Notifier {
  readonly name = "log";
  private readonly logger = new Logger("AlertRouting:LogNotifier");

  notify(incident: Incident, transition: IncidentTransition): void {
    const line = `[${incident.severity}] incident=${incident.id} feed=${incident.feedId} state=${incident.state} transition=${transition} :: ${incident.title}`;
    if (incident.severity === "page") this.logger.error(line);
    else if (incident.severity === "ticket") this.logger.warn(line);
    else this.logger.log(line);
  }
}

/** In-memory notifier that records deliveries — useful for tests/ops. */
export class InMemoryNotifier implements Notifier {
  readonly name = "memory";
  readonly deliveries: Array<{ incidentId: string; transition: IncidentTransition; at: string }> = [];

  constructor(private readonly clock: Clock = systemClock) {}

  notify(incident: Incident, transition: IncidentTransition): void {
    this.deliveries.push({
      incidentId: incident.id,
      transition,
      at: new Date(this.clock.now()).toISOString(),
    });
  }
}

/**
 * Computes a stable fingerprint for an alert. Volatile fields (timestamps,
 * observed values, messages) are intentionally excluded so that a flapping
 * feed collapses to a single fingerprint.
 */
export function fingerprintAlert(alert: Pick<RawAlert, "feedId" | "alertClass" | "source">): string {
  return `${alert.feedId}::${alert.alertClass}::${alert.source}`;
}

/**
 * Determines routing severity. Payout-triggering divergence pages; degraded
 * non-payout feeds open a ticket; everything else is informational.
 */
export function routeSeverity(alert: RawAlert): RoutingSeverity {
  if (alert.payoutTriggering || alert.alertClass === "divergence") return "page";
  if (alert.alertClass === "degraded" || alert.alertClass === "staleness" || alert.alertClass === "quorum") {
    return "ticket";
  }
  if (alert.severity === "critical") return "page";
  if (alert.severity === "warning") return "ticket";
  return "info";
}

let incidentCounter = 0;
function nextIncidentId(now: number): string {
  incidentCounter = (incidentCounter + 1) % 1_000_000;
  return `inc_${now.toString(36)}_${incidentCounter.toString(36)}`;
}

export interface AlertRoutingOptions {
  config?: Partial<RoutingConfig>;
  clock?: Clock;
  store?: IncidentStore;
  notifiers?: Notifier[];
  auditLog?: AuditLog;
  alerting?: AlertingService;
}

/**
 * Alert routing service implementing dedupe/group/route/escalate/resolve.
 *
 * All public methods are defensive: routing failures are logged and swallowed
 * so that callers on the ingestion/settlement path are never blocked.
 */
@Injectable()
export class AlertRoutingService {
  private readonly logger = new Logger(AlertRoutingService.name);
  private readonly config: RoutingConfig;
  private readonly clock: Clock;
  private readonly store: IncidentStore;
  private readonly notifiers: Notifier[];
  private readonly auditLog?: AuditLog;
  private readonly alerting?: AlertingService;

  /** fingerprint -> open incident id */
  private readonly openByFingerprint = new Map<string, string>();
  /** incident id -> incident */
  private readonly incidents = new Map<string, Incident>();
  /** fingerprint -> last emit timestamp (for dedup window) */
  private readonly lastEmitAt = new Map<string, number>();
  /** timestamps of incident creations for storm guard */
  private readonly creationTimestamps: number[] = [];
  private initialized = false;

  constructor(@Optional() options: AlertRoutingOptions = {}) {
    this.config = { ...DEFAULT_ROUTING_CONFIG, ...(options.config ?? {}) };
    this.clock = options.clock ?? systemClock;
    this.store = options.store ?? new InMemoryIncidentStore();
    this.notifiers = options.notifiers ?? [new LogNotifier()];
    this.auditLog = options.auditLog;
    this.alerting = options.alerting;
  }

  /** Restore open incidents from the store so a restart does not re-page. */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const open = await this.store.loadOpen();
      for (const incident of open) {
        this.incidents.set(incident.id, incident);
        this.openByFingerprint.set(incident.fingerprint, incident.id);
        this.lastEmitAt.set(incident.fingerprint, Date.parse(incident.updatedAt));
      }
      if (open.length > 0) {
        this.logger.log(`Restored ${open.length} open incident(s) from store`);
      }
    } catch (err) {
      this.logger.error(`Failed to restore incidents: ${(err as Error).message}`);
    }
  }

  /**
   * Emit a raw alert into the routing pipeline. Never throws.
   */
  async emit(alert: RawAlert): Promise<Incident | undefined> {
    try {
      await this.init();
      const now = this.clock.now();
      const fingerprint = fingerprintAlert(alert);

      // Resolution path: clear the open incident for this fingerprint.
      if (alert.resolved) {
        return await this.resolveByFingerprint(fingerprint, now, "auto_resolved");
      }

      const existingId = this.openByFingerprint.get(fingerprint);
      if (existingId) {
        const existing = this.incidents.get(existingId);
        if (existing && existing.state !== "resolved") {
          // Dedup: within window, just record the dedup transition.
          const last = this.lastEmitAt.get(fingerprint) ?? 0;
          if (now - last < this.config.dedupWindowMs) {
            await this.recordTransition(existing, "deduped", now, "within dedup window");
            this.lastEmitAt.set(fingerprint, now);
            return existing;
          }
          // Outside window but still open: re-notify (bounded).
          this.lastEmitAt.set(fingerprint, now);
          await this.maybeRenotify(existing, now);
          return existing;
        }
      }

      // Storm guard: bound incident creation rate.
      this.pruneCreationTimestamps(now);
      if (this.creationTimestamps.length >= this.config.maxIncidentsPerWindow) {
        this.logger.warn(
          `Storm guard: suppressing new incident for ${fingerprint} (${this.creationTimestamps.length} in window)`,
        );
        return undefined;
      }

      return await this.createIncident(alert, fingerprint, now);
    } catch (err) {
      this.logger.error(`Alert routing failed (swallowed): ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Acknowledge an incident. */
  async acknowledge(incidentId: string, actor: string): Promise<Incident | undefined> {
    try {
      await this.init();
      const incident = this.incidents.get(incidentId);
      if (!incident || incident.state === "resolved") return incident;
      const now = this.clock.now();
      incident.state = "acknowledged";
      incident.acknowledgedAt = new Date(now).toISOString();
      incident.acknowledgedBy = actor;
      incident.updatedAt = incident.acknowledgedAt;
      await this.recordTransition(incident, "acknowledged", now, undefined, actor);
      await this.persist(incident);
      return incident;
    } catch (err) {
      this.logger.error(`Acknowledge failed (swallowed): ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Manually resolve an incident. */
  async resolve(incidentId: string, actor = "system"): Promise<Incident | undefined> {
    try {
      await this.init();
      const incident = this.incidents.get(incidentId);
      if (!incident || incident.state === "resolved") return incident;
      return await this.finalizeResolution(incident, this.clock.now(), "resolved", actor);
    } catch (err) {
      this.logger.error(`Resolve failed (swallowed): ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * Drive time-based transitions (re-notify, escalate). Call periodically from
   * a scheduler. Never throws.
   */
  async tick(): Promise<void> {
    try {
      await this.init();
      const now = this.clock.now();
      for (const incident of this.incidents.values()) {
        if (incident.state === "resolved") continue;
        if (incident.state === "acknowledged") continue;
        const lastNotified = incident.lastNotifiedAt ? Date.parse(incident.lastNotifiedAt) : Date.parse(incident.createdAt);
        const elapsed = now - lastNotified;

        if (incident.state === "open" && elapsed >= this.config.escalationDelayMs) {
          await this.escalate(incident, now);
        } else if (elapsed >= this.config.renotifyDelayMs) {
          await this.maybeRenotify(incident, now);
        }
      }
    } catch (err) {
      this.logger.error(`Routing tick failed (swallowed): ${(err as Error).message}`);
    }
  }

  listIncidents(state?: IncidentState): Incident[] {
    const all = [...this.incidents.values()];
    return state ? all.filter((i) => i.state === state) : all;
  }

  getIncident(id: string): Incident | undefined {
    return this.incidents.get(id);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async createIncident(alert: RawAlert, fingerprint: string, now: number): Promise<Incident> {
    const severity = routeSeverity(alert);
    const at = new Date(now).toISOString();
    const incident: Incident = {
      id: nextIncidentId(now),
      fingerprint,
      feedId: alert.feedId,
      alertClass: alert.alertClass,
      source: alert.source,
      severity,
      state: "open",
      title: alert.title,
      message: alert.message,
      context: alert.context,
      createdAt: at,
      updatedAt: at,
      notificationCount: 0,
      timeline: [],
    };
    this.incidents.set(incident.id, incident);
    this.openByFingerprint.set(fingerprint, incident.id);
    this.lastEmitAt.set(fingerprint, now);
    this.creationTimestamps.push(now);

    await this.recordTransition(incident, "opened", now, `severity=${severity}`);
    await this.deliver(incident, "notified", now);
    await this.persist(incident);
    return incident;
  }

  private async resolveByFingerprint(
    fingerprint: string,
    now: number,
    transition: IncidentTransition,
  ): Promise<Incident | undefined> {
    const id = this.openByFingerprint.get(fingerprint);
    if (!id) return undefined;
    const incident = this.incidents.get(id);
    if (!incident || incident.state === "resolved") return incident;
    return await this.finalizeResolution(incident, now, transition, "system");
  }

  private async finalizeResolution(
    incident: Incident,
    now: number,
    transition: IncidentTransition,
    actor: string,
  ): Promise<Incident> {
    incident.state = "resolved";
    incident.resolvedAt = new Date(now).toISOString();
    incident.updatedAt = incident.resolvedAt;
    this.openByFingerprint.delete(incident.fingerprint);
    await this.recordTransition(incident, transition, now, undefined, actor);
    await this.deliver(incident, transition, now);
    await this.persist(incident);
    return incident;
  }

  private async maybeRenotify(incident: Incident, now: number): Promise<void> {
    if (incident.notificationCount >= this.config.maxNotificationsPerIncident) return;
    await this.recordTransition(incident, "renotified", now);
    await this.deliver(incident, "renotified", now);
    await this.persist(incident);
  }

  private async escalate(incident: Incident, now: number): Promise<void> {
    if (incident.state === "escalated" || incident.state === "resolved") return;
    incident.state = "escalated";
    incident.escalatedAt = new Date(now).toISOString();
    incident.updatedAt = incident.escalatedAt;
    await this.recordTransition(incident, "escalated", now, "secondary on-call");
    await this.deliver(incident, "escalated", now);
    await this.persist(incident);
  }

  private async deliver(incident: Incident, transition: IncidentTransition, now: number): Promise<void> {
    if (incident.notificationCount >= this.config.maxNotificationsPerIncident) return;
    incident.notificationCount += 1;
    incident.lastNotifiedAt = new Date(now).toISOString();
    incident.updatedAt = incident.lastNotifiedAt;
    for (const notifier of this.notifiers) {
      try {
        await notifier.notify(incident, transition);
      } catch (err) {
        this.logger.error(`Notifier ${notifier.name} failed (swallowed): ${(err as Error).message}`);
      }
    }
    // Mirror into the base alerting sink for ops visibility.
    if (this.alerting) {
      try {
        const sev: AlertSeverity =
          incident.severity === "page" ? "critical" : incident.severity === "ticket" ? "warning" : "info";
        this.alerting.emit(sev, `[incident ${incident.id}] ${incident.title}`, `${transition} (${incident.state})`, {
          feedId: incident.feedId,
          alertClass: incident.alertClass,
          source: incident.source,
        });
      } catch {
        /* ignore */
      }
    }
  }

  private async recordTransition(
    incident: Incident,
    transition: IncidentTransition,
    now: number,
    detail?: string,
    actor?: string,
  ): Promise<void> {
    const at = new Date(now).toISOString();
    const entry: IncidentTimelineEntry = { at, transition, detail, actor };
    incident.timeline.push(entry);
    incident.updatedAt = at;
    if (this.auditLog) {
      try {
        await this.auditLog.record({
          incidentId: incident.id,
          feedId: incident.feedId,
          transition,
          state: incident.state,
          at,
          detail,
          actor,
        });
      } catch (err) {
        this.logger.error(`Audit log write failed (swallowed): ${(err as Error).message}`);
      }
    }
  }

  private async persist(incident: Incident): Promise<void> {
    try {
      await this.store.save(incident);
    } catch (err) {
      this.logger.error(`Persist failed (swallowed): ${(err as Error).message}`);
    }
  }

  private pruneCreationTimestamps(now: number): void {
    const cutoff = now - this.config.dedupWindowMs;
    while (this.creationTimestamps.length > 0 && this.creationTimestamps[0] < cutoff) {
      this.creationTimestamps.shift();
    }
  }
}