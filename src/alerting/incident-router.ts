import crypto from "node:crypto";

export type AlertClass =
  | "payout_divergence"
  | "quorum_failure"
  | "feed_staleness"
  | "provider_outage"
  | "degraded_mode";

export type RoutingChannel = "page_primary" | "page_secondary" | "ticket" | "audit_only";

export type IncidentState = "open" | "acknowledged" | "escalated" | "resolved";

export interface RawOracleAlert {
  feedId: string;
  alertClass: AlertClass;
  source: string;
  payoutTriggering: boolean;
  message: string;
  timestampMs?: number;
  volatileContext?: Record<string, unknown>;
}

export interface IncidentTimelineEntry {
  atMs: number;
  event:
    | "created"
    | "deduplicated"
    | "grouped"
    | "renotified"
    | "acknowledged"
    | "escalated"
    | "resolved";
  detail: string;
  fingerprint?: string;
}

export interface OracleIncident {
  incidentId: string;
  groupKey: string;
  primaryFeedId: string;
  source: string;
  alertClasses: AlertClass[];
  fingerprints: string[];
  affectedFeeds: string[];
  payoutTriggering: boolean;
  channel: RoutingChannel;
  state: IncidentState;
  openedAtMs: number;
  updatedAtMs: number;
  lastNotifiedAtMs: number;
  acknowledgedAtMs: number | null;
  acknowledgedBy: string | null;
  escalatedAtMs: number | null;
  resolvedAtMs: number | null;
  occurrenceCount: number;
  lastFingerprintedAtMs: Record<string, number>;
  timeline: IncidentTimelineEntry[];
}

export interface IncidentNotification {
  incidentId: string;
  groupKey: string;
  channel: RoutingChannel;
  reason: "initial" | "severity_upgrade" | "renotify" | "escalate" | "resolved";
  state: IncidentState;
  affectedFeeds: string[];
  alertClasses: AlertClass[];
  atMs: number;
}

export interface AlertNotifier {
  notify(notification: IncidentNotification): Promise<void> | void;
}

export interface IncidentStore {
  getOpenByGroupKey(groupKey: string): Promise<OracleIncident | null>;
  getById(incidentId: string): Promise<OracleIncident | null>;
  save(incident: OracleIncident): Promise<void>;
  listOpen(): Promise<OracleIncident[]>;
}

export class InMemoryIncidentStore implements IncidentStore {
  private readonly byId = new Map<string, OracleIncident>();
  private readonly openByGroup = new Map<string, string>();

  async getOpenByGroupKey(groupKey: string): Promise<OracleIncident | null> {
    const id = this.openByGroup.get(groupKey);
    if (!id) return null;
    const inc = this.byId.get(id) ?? null;
    if (!inc || inc.state === "resolved") return null;
    return structuredClone(inc);
  }

  async getById(incidentId: string): Promise<OracleIncident | null> {
    const inc = this.byId.get(incidentId);
    return inc ? structuredClone(inc) : null;
  }

  async save(incident: OracleIncident): Promise<void> {
    const copy = structuredClone(incident);
    this.byId.set(copy.incidentId, copy);
    if (copy.state === "resolved") {
      if (this.openByGroup.get(copy.groupKey) === copy.incidentId) {
        this.openByGroup.delete(copy.groupKey);
      }
    } else {
      this.openByGroup.set(copy.groupKey, copy.incidentId);
    }
  }

  async listOpen(): Promise<OracleIncident[]> {
    const out: OracleIncident[] = [];
    for (const inc of this.byId.values()) {
      if (inc.state !== "resolved") {
        out.push(structuredClone(inc));
      }
    }
    return out;
  }
}

export interface IncidentRouterConfig {
  dedupWindowMs?: number;
  renotifyIntervalMs?: number;
  escalateAfterMs?: number;
  groupByProviderOutage?: boolean;
}

/**
 * Computes a deterministic alert fingerprint over (feedId, alertClass, source),
 * deliberately excluding volatile fields (observed value, timestamp, request ID).
 */
export function computeAlertFingerprint(
  alert: Pick<RawOracleAlert, "feedId" | "alertClass" | "source">
): string {
  const normalized = `${alert.feedId.trim().toLowerCase()}|${alert.alertClass}|${alert.source.trim().toLowerCase()}`;
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

/**
 * Groups correlated alerts into a single incident:
 * - Provider-wide outages (`provider_outage` or shared failing upstream `source`
 *   when `groupByProviderOutage` is enabled) group by `provider:<source>` so an
 *   upstream outage across N feeds opens ONE incident instead of N pages.
 * - Feed-specific anomalies group by `feed:<feedId>`.
 */
export function computeIncidentGroupKey(
  alert: Pick<RawOracleAlert, "feedId" | "alertClass" | "source">,
  groupByProviderOutage = true
): string {
  const src = alert.source.trim().toLowerCase();
  if (
    groupByProviderOutage &&
    (alert.alertClass === "provider_outage" || alert.alertClass === "feed_staleness") &&
    src &&
    src !== "unknown"
  ) {
    return `provider:${src}`;
  }
  return `feed:${alert.feedId.trim().toLowerCase()}`;
}

export function selectInitialRoutingChannel(alert: RawOracleAlert): RoutingChannel {
  if (alert.payoutTriggering || alert.alertClass === "payout_divergence") {
    return "page_primary";
  }
  return "ticket";
}

export class OracleIncidentRouter {
  private readonly store: IncidentStore;
  private readonly notifier: AlertNotifier;
  private readonly dedupWindowMs: number;
  private readonly renotifyIntervalMs: number;
  private readonly escalateAfterMs: number;
  private readonly groupByProviderOutage: boolean;
  private readonly auditLog: IncidentTimelineEntry[] = [];

  constructor(params: {
    store?: IncidentStore;
    notifier: AlertNotifier;
    config?: IncidentRouterConfig;
  }) {
    this.store = params.store ?? new InMemoryIncidentStore();
    this.notifier = params.notifier;
    this.dedupWindowMs = params.config?.dedupWindowMs ?? 5 * 60 * 1000;
    this.renotifyIntervalMs = params.config?.renotifyIntervalMs ?? 15 * 60 * 1000;
    this.escalateAfterMs = params.config?.escalateAfterMs ?? 10 * 60 * 1000;
    this.groupByProviderOutage = params.config?.groupByProviderOutage ?? true;
  }

  getAuditLog(): IncidentTimelineEntry[] {
    return [...this.auditLog];
  }

  private async safeNotify(notification: IncidentNotification): Promise<void> {
    try {
      await this.notifier.notify(notification);
    } catch {
      // Routing/notifier failure must never block oracle ingestion or claim settlement
    }
  }

  private recordTimeline(incident: OracleIncident, entry: IncidentTimelineEntry): void {
    incident.timeline.push(entry);
    this.auditLog.push(entry);
  }

  async ingestAlert(alert: RawOracleAlert): Promise<{
    incident: OracleIncident;
    deduplicated: boolean;
    grouped: boolean;
    notified: boolean;
  }> {
    const nowMs = alert.timestampMs ?? Date.now();
    const fingerprint = computeAlertFingerprint(alert);
    const groupKey = computeIncidentGroupKey(alert, this.groupByProviderOutage);
    const existing = await this.store.getOpenByGroupKey(groupKey);

    if (!existing) {
      const incidentId = `inc_${crypto
        .createHash("sha256")
        .update(`${groupKey}:${nowMs}:${fingerprint}`)
        .digest("hex")
        .slice(0, 16)}`;
      const channel = selectInitialRoutingChannel(alert);
      const created: OracleIncident = {
        incidentId,
        groupKey,
        primaryFeedId: alert.feedId,
        source: alert.source,
        alertClasses: [alert.alertClass],
        fingerprints: [fingerprint],
        affectedFeeds: [alert.feedId],
        payoutTriggering: alert.payoutTriggering,
        channel,
        state: "open",
        openedAtMs: nowMs,
        updatedAtMs: nowMs,
        lastNotifiedAtMs: nowMs,
        acknowledgedAtMs: null,
        acknowledgedBy: null,
        escalatedAtMs: null,
        resolvedAtMs: null,
        occurrenceCount: 1,
        lastFingerprintedAtMs: { [fingerprint]: nowMs },
        timeline: [],
      };
      this.recordTimeline(created, {
        atMs: nowMs,
        event: "created",
        detail: `Incident opened for ${groupKey} (${alert.alertClass})`,
        fingerprint,
      });
      await this.store.save(created);
      await this.safeNotify({
        incidentId: created.incidentId,
        groupKey: created.groupKey,
        channel: created.channel,
        reason: "initial",
        state: created.state,
        affectedFeeds: created.affectedFeeds,
        alertClasses: created.alertClasses,
        atMs: nowMs,
      });
      return { incident: created, deduplicated: false, grouped: false, notified: true };
    }

    existing.occurrenceCount += 1;
    existing.updatedAtMs = nowMs;

    const lastSeenAt = existing.lastFingerprintedAtMs[fingerprint];
    const withinDedupWindow =
      lastSeenAt !== undefined && nowMs - lastSeenAt < this.dedupWindowMs;
    existing.lastFingerprintedAtMs[fingerprint] = nowMs;

    if (!existing.fingerprints.includes(fingerprint)) {
      existing.fingerprints.push(fingerprint);
    }
    if (!existing.affectedFeeds.includes(alert.feedId)) {
      existing.affectedFeeds.push(alert.feedId);
    }
    if (!existing.alertClasses.includes(alert.alertClass)) {
      existing.alertClasses.push(alert.alertClass);
    }

    const upgradedToPage =
      !existing.payoutTriggering &&
      (alert.payoutTriggering || alert.alertClass === "payout_divergence");
    if (upgradedToPage) {
      existing.payoutTriggering = true;
      existing.channel = "page_primary";
    }

    if (withinDedupWindow && !upgradedToPage) {
      this.recordTimeline(existing, {
        atMs: nowMs,
        event: "deduplicated",
        detail: `Suppressed duplicate alert ${fingerprint} within dedup window`,
        fingerprint,
      });
      await this.store.save(existing);
      return { incident: existing, deduplicated: true, grouped: false, notified: false };
    }

    this.recordTimeline(existing, {
      atMs: nowMs,
      event: "grouped",
      detail: `Grouped alert (${alert.feedId}/${alert.alertClass}) into incident ${existing.incidentId}`,
      fingerprint,
    });

    let notified = false;
    if (upgradedToPage) {
      existing.lastNotifiedAtMs = nowMs;
      notified = true;
      await this.store.save(existing);
      await this.safeNotify({
        incidentId: existing.incidentId,
        groupKey: existing.groupKey,
        channel: existing.channel,
        reason: "severity_upgrade",
        state: existing.state,
        affectedFeeds: existing.affectedFeeds,
        alertClasses: existing.alertClasses,
        atMs: nowMs,
      });
    } else {
      await this.store.save(existing);
    }

    return { incident: existing, deduplicated: false, grouped: true, notified };
  }

  async acknowledge(incidentId: string, operatorId: string, nowMs = Date.now()): Promise<OracleIncident | null> {
    const incident = await this.store.getById(incidentId);
    if (!incident || incident.state === "resolved") return null;

    incident.state = "acknowledged";
    incident.acknowledgedAtMs = nowMs;
    incident.acknowledgedBy = operatorId;
    incident.updatedAtMs = nowMs;
    this.recordTimeline(incident, {
      atMs: nowMs,
      event: "acknowledged",
      detail: `Acknowledged by ${operatorId}`,
    });
    await this.store.save(incident);
    return incident;
  }

  /**
   * Periodic timer check that evaluates open incidents for secondary on-call
   * escalation (`escalateAfterMs`) and unacknowledged re-notification
   * (`renotifyIntervalMs`).
   */
  async tick(nowMs = Date.now()): Promise<OracleIncident[]> {
    const openIncidents = await this.store.listOpen();
    const touched: OracleIncident[] = [];

    for (const incident of openIncidents) {
      if (incident.state === "acknowledged") continue;

      if (
        incident.state === "open" &&
        incident.channel === "page_primary" &&
        nowMs - incident.openedAtMs >= this.escalateAfterMs
      ) {
        incident.state = "escalated";
        incident.channel = "page_secondary";
        incident.escalatedAtMs = nowMs;
        incident.lastNotifiedAtMs = nowMs;
        incident.updatedAtMs = nowMs;
        this.recordTimeline(incident, {
          atMs: nowMs,
          event: "escalated",
          detail: `Escalated unacknowledged incident to secondary on-call after ${nowMs - incident.openedAtMs}ms`,
        });
        await this.store.save(incident);
        await this.safeNotify({
          incidentId: incident.incidentId,
          groupKey: incident.groupKey,
          channel: "page_secondary",
          reason: "escalate",
          state: incident.state,
          affectedFeeds: incident.affectedFeeds,
          alertClasses: incident.alertClasses,
          atMs: nowMs,
        });
        touched.push(incident);
        continue;
      }

      if (nowMs - incident.lastNotifiedAtMs >= this.renotifyIntervalMs) {
        incident.lastNotifiedAtMs = nowMs;
        incident.updatedAtMs = nowMs;
        this.recordTimeline(incident, {
          atMs: nowMs,
          event: "renotified",
          detail: `Re-notified unacknowledged incident on ${incident.channel}`,
        });
        await this.store.save(incident);
        await this.safeNotify({
          incidentId: incident.incidentId,
          groupKey: incident.groupKey,
          channel: incident.channel,
          reason: "renotify",
          state: incident.state,
          affectedFeeds: incident.affectedFeeds,
          alertClasses: incident.alertClasses,
          atMs: nowMs,
        });
        touched.push(incident);
      }
    }

    return touched;
  }

  /**
   * Automatically resolves an open incident when its underlying feed/provider
   * condition clears, appending the resolution entry to the incident timeline
   * and audit log.
   */
  async resolveByGroupKey(groupKey: string, reason = "Condition cleared", nowMs = Date.now()): Promise<OracleIncident | null> {
    const incident = await this.store.getOpenByGroupKey(groupKey);
    if (!incident) return null;

    incident.state = "resolved";
    incident.resolvedAtMs = nowMs;
    incident.updatedAtMs = nowMs;
    this.recordTimeline(incident, {
      atMs: nowMs,
      event: "resolved",
      detail: reason,
    });
    await this.store.save(incident);
    await this.safeNotify({
      incidentId: incident.incidentId,
      groupKey: incident.groupKey,
      channel: incident.channel,
      reason: "resolved",
      state: "resolved",
      affectedFeeds: incident.affectedFeeds,
      alertClasses: incident.alertClasses,
      atMs: nowMs,
    });
    return incident;
  }
}
