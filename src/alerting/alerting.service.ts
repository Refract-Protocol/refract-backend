import { Injectable, Logger } from "@nestjs/common";

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
