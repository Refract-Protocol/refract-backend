import { Injectable, Logger } from "@nestjs/common";
import { RelayerAccountService } from "../stellar/relayer-account.service";

/**
 * Stub for future on-chain oracle reading publishes.
 *
 * Injects RelayerAccountService so settlement and oracle publishes share the
 * same sequence/fee submission queue once a real contract call is wired here.
 */
@Injectable()
export class OraclePublisherService {
  private readonly logger = new Logger(OraclePublisherService.name);

  constructor(private readonly relayerAccount: RelayerAccountService) {}

  isReady(): boolean {
    return this.relayerAccount.isReady();
  }

  /**
   * Placeholder publish path. Returns null until the oracle contract invoke
   * is implemented; readiness still flows through the shared relayer service.
   */
  async publishReading(_coverageType: number, _value: bigint): Promise<{ hash: string } | null> {
    if (!this.relayerAccount.isReady()) {
      this.logger.debug("Oracle publisher skipped — relayer not ready");
      return null;
    }
    this.logger.debug("Oracle on-chain publish is not implemented yet");
    return null;
  }

  /** Exposes the shared queue for future callers / tests. */
  submitViaRelayer(
    buildFn: Parameters<RelayerAccountService["submitRelayerTransaction"]>[0]
  ): ReturnType<RelayerAccountService["submitRelayerTransaction"]> {
    return this.relayerAccount.submitRelayerTransaction(buildFn);
  }
}
