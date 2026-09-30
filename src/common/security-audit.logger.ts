import { Injectable } from "@nestjs/common";
import * as winston from "winston";

export interface SecurityAuditEvent {
  event: "security_audit";
  timestamp: string;
  requestId: string;
  action: string;
  method: string;
  route: string;
  statusCode: number;
  outcome: "success" | "failure";
  actor: {
    address?: string;
    addressSource?: "request_body_claim" | "transaction_source";
    apiKeyFingerprint?: string;
  };
  changes: Record<string, string | number | boolean>;
}

@Injectable()
export class SecurityAuditLogger {
  private readonly logger = winston.createLogger({
    level: "info",
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    transports: [new winston.transports.Console()],
  });

  write(event: SecurityAuditEvent): void {
    this.logger.info(event);
  }
}
