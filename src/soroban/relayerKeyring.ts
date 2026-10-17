import { createHmac } from "node:crypto";

export type StellarNetworkName = "testnet" | "mainnet" | "futurenet";

export interface RelayerKeyEntry {
  keyId: string;
  publicKey: string;
  secretSeed: string;
  network: StellarNetworkName;
  active: boolean;
  revokedAtMs?: number;
}

export interface FeedSubmitterQuorumPolicy {
  feedId: string;
  network: StellarNetworkName;
  isPayoutTriggering: boolean;
  requiredSignatures: number;
}

export interface MultiSubmitterPublishRequest {
  decisionId: string;
  feedId: string;
  network: StellarNetworkName;
  payloadCanonical: string;
  nowMs?: number;
}

export interface SubmitterSignatureEnvelope {
  keyId: string;
  publicKey: string;
  signatureHex: string;
}

export interface MultiSubmitterPublishResult {
  decisionId: string;
  feedId: string;
  authoritativePublished: boolean;
  replayedFromIdempotentCache: boolean;
  requiredSignatures: number;
  collectedSignatures: SubmitterSignatureEnvelope[];
  failedKeyIds: string[];
  failureReason?: "THRESHOLD_NOT_MET" | "UNKNOWN_FEED_POLICY";
}

export interface KeyRotationAuditRecord {
  rotationId: string;
  revokedKeyId?: string;
  activatedKeyId: string;
  network: StellarNetworkName;
  rotatedAtMs: number;
  reason: string;
}

export class RelayerKeyring {
  private readonly keys = new Map<string, RelayerKeyEntry>();
  private readonly feedPolicies = new Map<string, FeedSubmitterQuorumPolicy>();
  private readonly publishedDecisions = new Map<
    string,
    MultiSubmitterPublishResult
  >();
  private readonly rotationAuditLog: KeyRotationAuditRecord[] = [];
  private readonly signerFaultInjector?: (keyId: string) => boolean;
  private seq = 0;

  constructor(options: {
    keys: RelayerKeyEntry[];
    feedPolicies: FeedSubmitterQuorumPolicy[];
    signerFaultInjector?: (keyId: string) => boolean;
  }) {
    this.signerFaultInjector = options.signerFaultInjector;
    for (const k of options.keys) {
      if (!k.secretSeed || k.secretSeed.length < 16) {
        throw new Error(`Invalid relayer secret material for keyId ${k.keyId}`);
      }
      this.keys.set(k.keyId, { ...k });
    }

    for (const policy of options.feedPolicies) {
      if (policy.requiredSignatures < 1) {
        throw new Error(
          `Invalid requiredSignatures (${policy.requiredSignatures}) for feed ${policy.feedId}`
        );
      }
      const activeForNet = this.getActiveKeysForNetwork(policy.network);
      if (policy.requiredSignatures > activeForNet.length) {
        throw new Error(
          `RelayerKeyring startup validation failed for feed ${policy.feedId}: requiredSignatures (${policy.requiredSignatures}) exceeds active keys (${activeForNet.length}) on ${policy.network}`
        );
      }
      this.feedPolicies.set(policy.feedId, { ...policy });
    }
  }

  public rotateKey(params: {
    revokeKeyId?: string;
    newKey: RelayerKeyEntry;
    reason: string;
    nowMs?: number;
  }): KeyRotationAuditRecord {
    const nowMs = params.nowMs ?? Date.now();
    if (!params.newKey.secretSeed || params.newKey.secretSeed.length < 16) {
      throw new Error("Invalid replacement key secret material");
    }

    this.keys.set(params.newKey.keyId, {
      ...params.newKey,
      active: true,
    });

    if (params.revokeKeyId) {
      const old = this.keys.get(params.revokeKeyId);
      if (!old) {
        throw new Error(`Unknown keyId to revoke: ${params.revokeKeyId}`);
      }
      old.active = false;
      old.revokedAtMs = nowMs;
    }

    // Verify all feed policies on that network still have enough active keys
    for (const policy of this.feedPolicies.values()) {
      if (policy.network === params.newKey.network) {
        const activeCount = this.getActiveKeysForNetwork(policy.network).length;
        if (activeCount < policy.requiredSignatures) {
          throw new Error(
            `Rotation aborted: active keys (${activeCount}) would drop below threshold (${policy.requiredSignatures}) for feed ${policy.feedId}`
          );
        }
      }
    }

    this.seq += 1;
    const record: KeyRotationAuditRecord = {
      rotationId: `rot-${this.seq}`,
      revokedKeyId: params.revokeKeyId,
      activatedKeyId: params.newKey.keyId,
      network: params.newKey.network,
      rotatedAtMs: nowMs,
      reason: params.reason,
    };
    this.rotationAuditLog.push(record);
    return { ...record };
  }

  public publishWithThreshold(
    req: MultiSubmitterPublishRequest
  ): MultiSubmitterPublishResult {
    // Idempotent per decisionId so retries or mid-flight rotations never double-publish
    const existing = this.publishedDecisions.get(req.decisionId);
    if (existing && existing.authoritativePublished) {
      return {
        ...existing,
        replayedFromIdempotentCache: true,
      };
    }

    const policy = this.feedPolicies.get(req.feedId);
    if (!policy || policy.network !== req.network) {
      return {
        decisionId: req.decisionId,
        feedId: req.feedId,
        authoritativePublished: false,
        replayedFromIdempotentCache: false,
        requiredSignatures: 0,
        collectedSignatures: [],
        failedKeyIds: [],
        failureReason: "UNKNOWN_FEED_POLICY",
      };
    }

    // Snapshot active keys at the start of the signing attempt
    const activeKeys = this.getActiveKeysForNetwork(req.network);
    const collectedSignatures: SubmitterSignatureEnvelope[] = [];
    const failedKeyIds: string[] = [];

    for (const key of activeKeys) {
      if (collectedSignatures.length >= policy.requiredSignatures) {
        break;
      }
      if (this.signerFaultInjector && this.signerFaultInjector(key.keyId)) {
        failedKeyIds.push(key.keyId);
        continue;
      }

      const sigHex = createHmac("sha256", key.secretSeed)
        .update(`${req.decisionId}:${req.feedId}:${req.payloadCanonical}`)
        .digest("hex");

      collectedSignatures.push({
        keyId: key.keyId,
        publicKey: key.publicKey,
        signatureHex: sigHex,
      });
    }

    if (collectedSignatures.length < policy.requiredSignatures) {
      return {
        decisionId: req.decisionId,
        feedId: req.feedId,
        authoritativePublished: false,
        replayedFromIdempotentCache: false,
        requiredSignatures: policy.requiredSignatures,
        collectedSignatures,
        failedKeyIds,
        failureReason: "THRESHOLD_NOT_MET",
      };
    }

    const result: MultiSubmitterPublishResult = {
      decisionId: req.decisionId,
      feedId: req.feedId,
      authoritativePublished: true,
      replayedFromIdempotentCache: false,
      requiredSignatures: policy.requiredSignatures,
      collectedSignatures,
      failedKeyIds,
    };

    this.publishedDecisions.set(req.decisionId, result);
    return result;
  }

  public getActiveKeysForNetwork(
    network: StellarNetworkName
  ): Array<{ keyId: string; publicKey: string; secretSeed: string }> {
    const list: Array<{ keyId: string; publicKey: string; secretSeed: string }> =
      [];
    for (const k of this.keys.values()) {
      if (k.active && k.network === network) {
        list.push({
          keyId: k.keyId,
          publicKey: k.publicKey,
          secretSeed: k.secretSeed,
        });
      }
    }
    return list;
  }

  public getRotationAuditLog(): KeyRotationAuditRecord[] {
    return this.rotationAuditLog.map((r) => ({ ...r }));
  }
}
