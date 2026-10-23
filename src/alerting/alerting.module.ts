import { Module } from "@nestjs/common";
import { AlertingService } from "./alerting.service";
import { AlertRoutingService } from "./routing/alert-routing.service";
import { IncidentRepository } from "./routing/incident.repository";
import { IncidentEscalationService } from "./routing/incident-escalation.service";
import { IncidentTimelineService } from "./routing/incident-timeline.service";
import { AlertFingerprintService } from "./routing/alert-fingerprint.service";
import { AlertGroupingService } from "./routing/alert-grouping.service";
import { AlertSeverityRouter } from "./routing/alert-severity-router.service";
import { NOTIFIER, LoggingNotifier } from "./routing/notifiers/notifier.interface";

@Module({
  providers: [
    AlertingService,
    AlertFingerprintService,
    AlertGroupingService,
    AlertSeverityRouter,
    IncidentRepository,
    IncidentTimelineService,
    IncidentEscalationService,
    AlertRoutingService,
    {
      provide: NOTIFIER,
      useClass: LoggingNotifier,
    },
  ],
  exports: [
    AlertingService,
    AlertFingerprintService,
    AlertGroupingService,
    AlertSeverityRouter,
    IncidentRepository,
    IncidentTimelineService,
    IncidentEscalationService,
    AlertRoutingService,
    NOTIFIER,
  ],
})
export class AlertingModule {}