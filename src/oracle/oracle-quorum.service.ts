import { Injectable, Logger } from "@nestjs/common";
import { buildPublishPayload } from "./oracle-encoding";
import { KeySignature, QuorumNotMetError, RelayerKeyring } from "../stellar/relayer-keyring.service";

export interface QuorumRequest {
  oracleContractId: string;
  network: string;
  feed: string;
  value: number;
  decisionId: string;
}

export interface QuorumResult {
  decisionId: string;
  feed: string;
  required: number;
  signatures: KeySignature[];
  authoritative: true;
}

/**
 * Aggregates N-of-M submitter signatures for one oracle decision. A value is
 * authoritative only when the feed's threshold is met by signatures from
 * keys that are still active when collection finishes — a rotation or
 * revocation mid-flight drops the affected signatures and either re-signs
 * with a remaining key or fails closed. Results are cached per decision id so
 * a retry returns the same signature set instead of producing a second publish.
 */
@Injectable()
export class OracleQuorumService {
  private readonly logger = new Logger(OracleQuorumService.name);
  private readonly decisions = new Map<string, Promise<QuorumResult>>();
  private static readonly MAX_REVALIDATIONS = 3;

  constructor(private readonly keyring: RelayerKeyring) {}

  collect(req: QuorumRequest): Promise<QuorumResult> {
    const existing = this.decisions.get(req.decisionId);
    if (existing) return existing;
    const run = this.run(req).catch((err) => {
      // Failures are not cached: a retry may succeed once keys recover.
      this.decisions.delete(req.decisionId);
      throw err;
    });
    this.decisions.set(req.decisionId, run);
    return run;
  }

  private async run(req: QuorumRequest): Promise<QuorumResult> {
    const payload = buildPublishPayload(req.oracleContractId, req.feed, req.value, req.decisionId);
    const required = this.keyring.requiredSignatures(req.feed);
    for (let attempt = 0; attempt < OracleQuorumService.MAX_REVALIDATIONS; attempt++) {
      const signatures = this.keyring.signFor(req.feed, payload, req.network);
      // Rotation check: drop signatures from keys revoked while we were signing.
      const valid = signatures.filter((s) => this.keyring.isActive(s.keyId));
      if (valid.length >= required && new Set(valid.map((s) => s.publicKey)).size >= required) {
        return { decisionId: req.decisionId, feed: req.feed, required, signatures: valid, authoritative: true };
      }
      this.logger.warn(`Keyring changed during quorum collection for ${req.decisionId}; re-collecting`);
    }
    throw new QuorumNotMetError(`Quorum for ${req.decisionId} not stable across key rotation; refusing to publish`);
  }
}
