export type IncidentTriggerClass =
  | "CIRCUIT_BREAKER_TRIP"
  | "QUORUM_FAILURE"
  | "FRESHNESS_BREACH"
  | "OPERATOR_PAUSE"
  | "BACKFILL_REPLAY"
  | "MANUAL_OPEN";

export type IncidentLedgerEventType =
  | "TRIGGER_FIRED"
  | "SOURCE_READING"
  | "CONSENSUS_OUTCOME"
  | "TRUST_MODE_CHANGE"
  | "CLAIM_SETTLED"
  | "CLAIM_HELD";

export interface IncidentTimelineEvent {
  eventId: string;
  timestampMs: number;
  eventType: IncidentLedgerEventType;
  feedId: string;
  summary: string;
  payoutExposureUsd?: number;
  metadata?: Record<string, unknown>;
}

export interface OracleIncidentRecord {
  incidentId: string;
  primaryFeedId: string;
  triggerClass: IncidentTriggerClass;
  openedAtMs: number;
  lastUpdatedAtMs: number;
  version: number;
  affectedFeeds: Set<string>;
  totalPayoutExposureUsd: number;
  events: IncidentTimelineEvent[];
}

const SENSITIVE_PATTERN =
  /(api[_-]?key|secret|token|password|private[_-]?key)\s*[:=]\s*[^\s,;]+/gi;

function sanitizeText(input: string): string {
  return input.replace(SENSITIVE_PATTERN, "$1=[REDACTED]");
}

function sanitizeMetadata(
  meta?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (/apikey|api_key|secret|token|password|privatekey/i.test(k)) {
      clean[k] = "[REDACTED]";
    } else if (typeof v === "string") {
      clean[k] = sanitizeText(v);
    } else {
      clean[k] = v;
    }
  }
  return clean;
}

export class IncidentPostmortemGenerator {
  private readonly groupingWindowMs: number;
  private readonly maxTimelineEvents: number;
  private readonly incidents = new Map<string, OracleIncidentRecord>();
  private readonly markdownCache = new Map<string, string>();
  private incidentSeq = 0;

  constructor(options?: {
    groupingWindowMs?: number;
    maxTimelineEvents?: number;
  }) {
    this.groupingWindowMs = options?.groupingWindowMs ?? 300_000; // 5 minutes
    this.maxTimelineEvents = options?.maxTimelineEvents ?? 50;
  }

  /**
   * Opens a new incident or groups into an active incident on the same feed within `groupingWindowMs`.
   */
  public openOrGroupIncident(params: {
    feedId: string;
    triggerClass: IncidentTriggerClass;
    timestampMs: number;
    summary: string;
  }): OracleIncidentRecord {
    for (const existing of this.incidents.values()) {
      if (
        existing.primaryFeedId === params.feedId &&
        params.timestampMs - existing.lastUpdatedAtMs <= this.groupingWindowMs
      ) {
        this.appendEvent(existing.incidentId, {
          eventId: `trig:${existing.events.length + 1}`,
          timestampMs: params.timestampMs,
          eventType: "TRIGGER_FIRED",
          feedId: params.feedId,
          summary: `[${params.triggerClass}] ${params.summary}`,
        });
        return existing;
      }
    }

    this.incidentSeq += 1;
    const incidentId = `INC-${String(this.incidentSeq).padStart(4, "0")}`;
    const record: OracleIncidentRecord = {
      incidentId,
      primaryFeedId: params.feedId,
      triggerClass: params.triggerClass,
      openedAtMs: params.timestampMs,
      lastUpdatedAtMs: params.timestampMs,
      version: 1,
      affectedFeeds: new Set([params.feedId]),
      totalPayoutExposureUsd: 0,
      events: [
        {
          eventId: "trig:1",
          timestampMs: params.timestampMs,
          eventType: "TRIGGER_FIRED",
          feedId: params.feedId,
          summary: sanitizeText(`[${params.triggerClass}] ${params.summary}`),
        },
      ],
    };
    this.incidents.set(incidentId, record);
    return record;
  }

  public appendEvent(
    incidentId: string,
    event: IncidentTimelineEvent
  ): OracleIncidentRecord {
    const incident = this.incidents.get(incidentId);
    if (!incident) {
      throw new Error(`Unknown incident '${incidentId}'`);
    }

    const sanitizedEvent: IncidentTimelineEvent = {
      ...event,
      summary: sanitizeText(event.summary),
      metadata: sanitizeMetadata(event.metadata),
    };

    incident.events.push(sanitizedEvent);
    incident.events.sort((a, b) => a.timestampMs - b.timestampMs);
    incident.affectedFeeds.add(event.feedId);
    if (
      typeof event.payoutExposureUsd === "number" &&
      event.payoutExposureUsd > 0
    ) {
      incident.totalPayoutExposureUsd += event.payoutExposureUsd;
    }
    incident.lastUpdatedAtMs = Math.max(
      incident.lastUpdatedAtMs,
      event.timestampMs
    );
    incident.version += 1;

    return incident;
  }

  public renderPostmortemMarkdown(incidentId: string): string {
    const incident = this.incidents.get(incidentId);
    if (!incident) {
      throw new Error(`Unknown incident '${incidentId}'`);
    }

    const cacheKey = `${incident.incidentId}:v${incident.version}`;
    const cached = this.markdownCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const feedsList = Array.from(incident.affectedFeeds).sort().join(", ");
    const visibleEvents = incident.events.slice(0, this.maxTimelineEvents);
    const truncatedCount = Math.max(
      0,
      incident.events.length - visibleEvents.length
    );

    const timelineLines = visibleEvents.map((e) => {
      const iso = new Date(e.timestampMs).toISOString();
      return `- **${iso}** \`[${e.eventType}]\` (${e.feedId}): ${e.summary}`;
    });

    if (truncatedCount > 0) {
      timelineLines.push(
        `- *[TRUNCATED: ${truncatedCount} additional ledger event(s) omitted for pagination]*`
      );
    }

    const markdown = [
      `# Draft Postmortem: ${incident.incidentId}`,
      ``,
      `## Incident Overview`,
      `- **Incident ID**: ${incident.incidentId}`,
      `- **Initial Trigger**: ${incident.triggerClass}`,
      `- **Opened At**: ${new Date(incident.openedAtMs).toISOString()}`,
      `- **Document Version**: v${incident.version}`,
      ``,
      `## Impact Summary`,
      `- **Affected Feeds**: ${feedsList}`,
      `- **Total Payout Exposure (USD)**: $${incident.totalPayoutExposureUsd.toFixed(2)}`,
      ``,
      `## Detection`,
      `- Automatically opened by oracle evidence ledger trigger \`${incident.triggerClass}\` on feed \`${incident.primaryFeedId}\`.`,
      ``,
      `## Chronological Timeline`,
      ...timelineLines,
      ``,
      `## Open Questions & Human Root-Cause Analysis`,
      `- **Root Cause (To Be Completed by Operator)**: _[Pending human investigation]_`,
      `- **Follow-Up Action Items**: _[Pending postmortem review]_`,
    ].join("\n");

    this.markdownCache.set(cacheKey, markdown);
    return markdown;
  }
}
