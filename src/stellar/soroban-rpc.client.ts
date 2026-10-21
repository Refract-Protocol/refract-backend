import { rpc } from "@stellar/stellar-sdk";
import {
  EndpointHealthSnapshot,
  RpcEndpointPool,
  RpcEndpointPoolOptions,
  RpcPurpose,
} from "./rpc-endpoint-pool";

export { isTransientRpcError } from "./rpc-endpoint-pool";

/**
 * Wraps all Soroban RPC calls with bounded retries and health-aware endpoint
 * selection. Only transport/server-throttling failures are retried; contract
 * and request errors are returned immediately.
 *
 * Backed by {@link RpcEndpointPool}: pass several URLs to remove the
 * single-provider dependency. Call `start()` to enable background health
 * probing; without it the pool still rotates away from endpoints that fail
 * calls.
 */
export class SorobanRpcClient {
  readonly pool: RpcEndpointPool<rpc.Server>;

  constructor(urls: string[], options: RpcEndpointPoolOptions<rpc.Server> = {}) {
    this.pool = new RpcEndpointPool<rpc.Server>(urls, options);
  }

  call<T>(operation: (server: rpc.Server) => Promise<T>, purpose: RpcPurpose = "read"): Promise<T> {
    return this.pool.call(operation, purpose);
  }

  start(): void {
    this.pool.start();
  }

  stop(): void {
    this.pool.stop();
  }

  health(): EndpointHealthSnapshot[] {
    return this.pool.snapshot();
  }
}
