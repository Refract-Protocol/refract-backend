import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { TransactionBuilder, Account, BASE_FEE, Keypair, Operation } from "@stellar/stellar-sdk";
import { Request, Response } from "express";
import { lastValueFrom, of, throwError } from "rxjs";
import { AppConfig } from "../config/configuration";
import { PoolController } from "../pool/pool.controller";
import { PolicyController } from "../policy/policy.controller";
import { TxController } from "../tx/tx.controller";
import { SecurityAuditEvent, SecurityAuditLogger } from "./security-audit.logger";
import { SecurityAuditInterceptor } from "./security-audit.interceptor";

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

function buildConfig(): ConfigService<AppConfig, true> {
  return {
    get: jest.fn().mockReturnValue({ networkPassphrase: NETWORK_PASSPHRASE }),
  } as unknown as ConfigService<AppConfig, true>;
}

function makeContext(handler: (...args: unknown[]) => unknown, request: Partial<Request>, response: Partial<Response>) {
  return {
    getHandler: () => handler,
    getType: () => "http",
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as never;
}

describe("SecurityAuditInterceptor", () => {
  const reflector = new Reflector();
  let write: jest.Mock;
  let logger: SecurityAuditLogger;

  beforeEach(() => {
    write = jest.fn();
    logger = { write } as unknown as SecurityAuditLogger;
  });

  it("marks every currently state-changing route with an audit action", () => {
    expect(Reflect.getMetadata("securityAuditAction", PoolController.prototype.provide)).toBe("pool.provide");
    expect(Reflect.getMetadata("securityAuditAction", PoolController.prototype.withdraw)).toBe("pool.withdraw");
    expect(Reflect.getMetadata("securityAuditAction", PolicyController.prototype.buy)).toBe("policy.buy");
    expect(Reflect.getMetadata("securityAuditAction", TxController.prototype.submit)).toBe("tx.submit");
  });

  it("writes structured success events with the claimed address and sanitized API-key fingerprint", async () => {
    const handler = () => undefined;
    Reflect.defineMetadata("securityAuditAction", "pool.provide", handler);
    const interceptor = new SecurityAuditInterceptor(reflector, buildConfig(), logger);
    const request = {
      method: "POST",
      baseUrl: "/api/v1/pool",
      route: { path: "provide" },
      body: { provider: "GABC", amount: "1000" },
      get: (name: string) => (name === "x-api-key" ? "secret-api-key" : "request-123"),
    } as unknown as Request;
    const response = { statusCode: 201 } as Response;

    await lastValueFrom(interceptor.intercept(makeContext(handler, request, response), { handle: () => of({}) } as never));

    const event = write.mock.calls[0][0] as SecurityAuditEvent;
    expect(event).toMatchObject({
      event: "security_audit",
      action: "pool.provide",
      method: "POST",
      route: "/api/v1/pool/provide",
      statusCode: 201,
      outcome: "success",
      requestId: "request-123",
      actor: {
        address: "GABC",
        addressSource: "request_body_claim",
        apiKeyFingerprint: expect.any(String),
      },
      changes: { operation: "pool.provide", provider: "GABC", amount: "1000" },
    });
    expect(JSON.stringify(event)).not.toContain("secret-api-key");
    expect(Number.isNaN(Date.parse(event.timestamp))).toBe(false);
  });

  it("records submitted transaction identity and hash without logging signed XDR", async () => {
    const handler = () => undefined;
    Reflect.defineMetadata("securityAuditAction", "tx.submit", handler);
    const interceptor = new SecurityAuditInterceptor(reflector, buildConfig(), logger);
    const signer = Keypair.random();
    const transaction = new TransactionBuilder(new Account(signer.publicKey(), "1"), {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
      .setTimeout(30)
      .build();
    transaction.sign(signer);
    const signedXdr = transaction.toXDR();
    const request = {
      method: "POST",
      baseUrl: "/api/v1/tx",
      route: { path: "submit" },
      body: { signedXdr },
      get: () => undefined,
    } as unknown as Request;

    await lastValueFrom(
      interceptor.intercept(
        makeContext(handler, request, { statusCode: 201 } as Response),
        { handle: () => of({}) } as never
      )
    );

    const event = write.mock.calls[0][0] as SecurityAuditEvent;
    expect(event.actor).toEqual({ address: signer.publicKey(), addressSource: "transaction_source" });
    expect(event.changes.transactionHash).toBe(transaction.hash().toString("hex"));
    expect(JSON.stringify(event)).not.toContain(signedXdr);
  });

  it("records failed mutations and rethrows the original error", async () => {
    const handler = () => undefined;
    Reflect.defineMetadata("securityAuditAction", "policy.buy", handler);
    const interceptor = new SecurityAuditInterceptor(reflector, buildConfig(), logger);
    const error = { getStatus: () => 400 };
    const request = {
      method: "POST",
      baseUrl: "/api/v1/policies",
      route: { path: "buy" },
      body: { holder: "GABC", coverageAmount: "9000", triggerParams: { flightNumber: "AB123" } },
      get: () => undefined,
    } as unknown as Request;

    await expect(
      lastValueFrom(
        interceptor.intercept(makeContext(handler, request, { statusCode: 201 } as Response), {
          handle: () => throwError(() => error),
        } as never)
      )
    ).rejects.toBe(error);

    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "policy.buy",
        statusCode: 400,
        outcome: "failure",
        changes: { operation: "policy.buy", holder: "GABC", coverageAmount: "9000" },
      })
    );
    expect(JSON.stringify(write.mock.calls[0][0])).not.toContain("AB123");
  });
});
