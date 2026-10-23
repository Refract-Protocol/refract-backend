import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { rpc } from "@stellar/stellar-sdk";
import { EndpointHealthSnapshot, RpcPurpose } from "./rpc-endpoint-pool";
import { resolveRpcPoolConfig } from "./rpc-pool.config";
import { SorobanRpcClient } from "./soroban-rpc.client";

/**
 * Process-wide Soroban RPC endpoint pool. Reads, event polling, and oracle
 * publish submissions should all go through this one instance so they share
 * health state: an endpoint that starts failing publishes is also skipped
 * for reads.
 */
@Injectable()
export class SorobanRpcPoolService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SorobanRpcPoolService.name);
  readonly client: SorobanRpcClient;

  constructor() {
    const config = resolveRpcPoolConfig();
    this.client = new SorobanRpcClient(config.urls, {
      ...config.options,
      logger: { warn: (m) => this.logger.warn(m), log: (m) => this.logger.log(m) },
    });
  }

  onModuleInit(): void {
    this.logger.log(`Soroban RPC pool started with ${this.client.pool.size} endpoint(s)`);
    this.client.start();
  }

  onModuleDestroy(): void {
    this.client.stop();
  }

  call<T>(operation: (server: rpc.Server) => Promise<T>, purpose: RpcPurpose = "read"): Promise<T> {
    return this.client.call(operation, purpose);
  }

  health(): EndpointHealthSnapshot[] {
    return this.client.health();
  }

  isServiceable(): boolean {
    return this.client.pool.isServiceable();
  }
}
