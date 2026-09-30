import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { FeeBumpTransaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { Request, Response } from "express";
import { createHash, randomUUID } from "node:crypto";
import { Observable, catchError, tap, throwError } from "rxjs";
import { AppConfig } from "../config/configuration";
import { SecurityAuditEvent, SecurityAuditLogger } from "./security-audit.logger";

const SECURITY_AUDIT_ACTION = "securityAuditAction";
const MUTATION_FIELDS: Record<string, string[]> = {
  "pool.provide": ["provider", "amount"],
  "pool.withdraw": ["provider", "shares"],
  "policy.buy": ["holder", "coverageType", "coverageAmount", "durationDays"],
};

export const SecurityAudit = (action: string): MethodDecorator => SetMetadata(SECURITY_AUDIT_ACTION, action);

@Injectable()
export class SecurityAuditInterceptor implements NestInterceptor {
  private readonly networkPassphrase: string;

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly auditLogger: SecurityAuditLogger
  ) {
    this.networkPassphrase = this.configService.get("stellar", { infer: true }).networkPassphrase;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const action = this.reflector.get<string>(SECURITY_AUDIT_ACTION, context.getHandler());
    if (!action || context.getType() !== "http") return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const event = this.createEvent(action, request);

    return next.handle().pipe(
      tap((result: unknown) =>
        this.auditLogger.write({
          ...event,
          timestamp: new Date().toISOString(),
          statusCode: response.statusCode,
          outcome: this.resultOutcome(result),
        })
      ),
      catchError((error: unknown) => {
        const statusCode =
          typeof error === "object" &&
          error !== null &&
          "getStatus" in error &&
          typeof error.getStatus === "function"
            ? error.getStatus()
            : 500;
        this.auditLogger.write({
          ...event,
          timestamp: new Date().toISOString(),
          statusCode,
          outcome: "failure",
        });
        return throwError(() => error);
      })
    );
  }

  private createEvent(
    action: string,
    request: Request
  ): Omit<SecurityAuditEvent, "timestamp" | "statusCode" | "outcome"> {
    const body = typeof request.body === "object" && request.body !== null ? request.body : {};
    const record = body as Record<string, unknown>;
    const routePath = request.route?.path;
    const path = typeof routePath === "string" ? routePath : "";
    const route = `${request.baseUrl ?? ""}${path && !path.startsWith("/") ? `/${path}` : path}`;
    const apiKey = request.get("x-api-key");
    const bodyAddress = this.stringField(record, "holder") ?? this.stringField(record, "provider");

    const actor: SecurityAuditEvent["actor"] = {};
    if (bodyAddress) {
      actor.address = bodyAddress;
      actor.addressSource = "request_body_claim";
    } else if (action === "tx.submit") {
      const parsed = this.transactionDetails(this.stringField(record, "signedXdr"));
      if (parsed.source) {
        actor.address = parsed.source;
        actor.addressSource = "transaction_source";
      }
    }
    if (apiKey) {
      actor.apiKeyFingerprint = createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
    }

    const changes: SecurityAuditEvent["changes"] = { operation: action };
    for (const field of MUTATION_FIELDS[action] ?? []) {
      const value = record[field];
      if (
        (typeof value === "string" && value.length <= 256) ||
        (typeof value === "number" && Number.isFinite(value)) ||
        typeof value === "boolean"
      ) {
        changes[field] = value;
      }
    }
    if (action === "tx.submit") {
      const details = this.transactionDetails(this.stringField(record, "signedXdr"));
      changes.transactionHash = details.hash ?? "unparseable";
    }

    const suppliedRequestId = request.get("x-request-id");
    const requestId =
      suppliedRequestId && /^[A-Za-z0-9._:-]{1,128}$/.test(suppliedRequestId) ? suppliedRequestId : randomUUID();

    return {
      event: "security_audit",
      requestId,
      action,
      method: request.method,
      route,
      actor,
      changes,
    };
  }

  private transactionDetails(signedXdr?: string): { source?: string; hash?: string } {
    if (!signedXdr) return {};
    try {
      const tx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
      const source = tx instanceof FeeBumpTransaction ? tx.innerTransaction.source : tx.source;
      return { source, hash: tx.hash().toString("hex") };
    } catch {
      return {};
    }
  }

  private stringField(record: Record<string, unknown>, field: string): string | undefined {
    const value = record[field];
    return typeof value === "string" && value.length <= 256 ? value : undefined;
  }

  private resultOutcome(result: unknown): "success" | "failure" {
    if (typeof result !== "object" || result === null) return "success";
    const record = result as Record<string, unknown>;
    if (typeof record.confirmed === "boolean") return record.confirmed ? "success" : "failure";
    if (typeof record.settled === "boolean") return record.settled ? "success" : "failure";
    return "success";
  }
}
