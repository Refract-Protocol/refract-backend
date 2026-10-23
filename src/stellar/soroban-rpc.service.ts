import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { rpc } from "@stellar/stellar-sdk";
import { AppConfig } from "../config/configuration";

/**
 * Thin wrapper around rpc.Server so fee-stat fetches and other RPC calls
 * share one constructed client (retry/timeout knobs live here later).
 */
@Injectable()
export class SorobanRpcService {
  readonly server: rpc.Server;
  readonly networkPassphrase: string;

  constructor(configService: ConfigService<AppConfig, true>) {
    const stellar = configService.get("stellar", { infer: true });
    this.server = new rpc.Server(stellar.sorobanRpcUrl);
    this.networkPassphrase = stellar.networkPassphrase;
  }
}
