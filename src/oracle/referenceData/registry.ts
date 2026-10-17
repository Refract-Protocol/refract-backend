/**
 * Versioned Reference Data Registry for Feed Entity Validation (Issue #287)
 *
 * Provides immutable, version-pinned reference datasets for airports, routes,
 * carriers, protocols, markets, and chain-qualified assets. Resolves provider-specific
 * aliases, disambiguates multi-chain ticker collisions, enforces effective time
 * windows, and routes invalid entities to a dead-letter queue with rate-limited alerts.
 */

export type ReferenceEntityKind =
  | "airport"
  | "route"
  | "carrier"
  | "protocol"
  | "market"
  | "asset";

export interface ProviderAliasMapping {
  providerId: string;
  nativeId: string;
  /** Optional chain qualifier for multi-chain asset tickers (e.g. "stellar", "ethereum") */
  chain?: string;
  /** Optional contract/issuer address qualifier */
  contractAddress?: string;
}

export interface ReferenceEntityRecord {
  /** Stable canonical entity ID (e.g. "airport:KJFK", "asset:stellar:USDC:GA5Z...") */
  canonicalId: string;
  kind: ReferenceEntityKind;
  displayName: string;
  /** Primary ticker or code (e.g. "JFK", "USDC", "AAVE-V3") */
  code: string;
  chain?: string;
  contractAddress?: string;
  /** Timestamp (ms) from which this entity is active */
  effectiveFromMs: number;
  /** Optional timestamp (ms) after which this entity is retired/delisted */
  effectiveToMs?: number;
  /** Optional canonical ID of successor entity if renamed/migrated */
  renamedToCanonicalId?: string;
  aliases: ProviderAliasMapping[];
}

export interface ReferenceDatasetSnapshot {
  datasetVersion: string;
  createdAtMs: number;
  entities: ReferenceEntityRecord[];
}

export interface DatasetDiffReport {
  fromVersion: string;
  toVersion: string;
  addedCanonicalIds: string[];
  removedCanonicalIds: string[];
  retiredCanonicalIds: string[];
  aliasChanges: string[];
}

export interface EntityResolutionQuery {
  feedId: string;
  pinnedDatasetVersion?: string;
  providerId: string;
  kind: ReferenceEntityKind;
  /** Provider-supplied entity identifier or ticker */
  rawIdentifier: string;
  chain?: string;
  contractAddress?: string;
  /** Event timestamp (ms) of the reading; used to check effectiveFromMs..effectiveToMs */
  eventTimestampMs: number;
  observedAtMs?: number;
}

export type DeadLetterReason =
  | "pinned_version_not_found"
  | "unknown_entity"
  | "retired_entity"
  | "not_yet_effective"
  | "ambiguous_entity_collision";

export interface DeadLetterEntityRecord {
  feedId: string;
  datasetVersion: string;
  providerId: string;
  rawIdentifier: string;
  reason: DeadLetterReason;
  detail: string;
  observedAtMs: number;
}

export interface EntityValidationResult {
  valid: boolean;
  canonicalId?: string;
  datasetVersion: string;
  entity?: ReferenceEntityRecord;
  deadLetter?: DeadLetterEntityRecord;
  alertEmitted: boolean;
}

export class VersionedReferenceDataRegistry {
  private readonly datasets = new Map<string, ReferenceDatasetSnapshot>();
  private readonly feedPinnedVersion = new Map<string, string>();
  private readonly deadLetters: DeadLetterEntityRecord[] = [];
  private readonly alertWindowMs: number;
  private readonly maxAlertsPerWindow: number;
  private readonly alertTimestampsByFeed = new Map<string, number[]>();

  constructor(options: { alertWindowMs?: number; maxAlertsPerWindow?: number } = {}) {
    this.alertWindowMs = options.alertWindowMs ?? 60_000;
    this.maxAlertsPerWindow = options.maxAlertsPerWindow ?? 3;
  }

  /**
   * Registers an immutable dataset version. Throws if the version string already exists.
   */
  registerDatasetVersion(snapshot: ReferenceDatasetSnapshot): void {
    if (!snapshot.datasetVersion || snapshot.datasetVersion.trim() === "") {
      throw new Error("datasetVersion must be non-empty");
    }
    if (this.datasets.has(snapshot.datasetVersion)) {
      throw new Error(
        `Reference dataset version "${snapshot.datasetVersion}" is immutable and already registered`
      );
    }
    // Deep-freeze copy to guarantee immutability per version
    const cloned: ReferenceDatasetSnapshot = {
      datasetVersion: snapshot.datasetVersion,
      createdAtMs: snapshot.createdAtMs,
      entities: snapshot.entities.map((e) => ({
        ...e,
        aliases: e.aliases.map((a) => ({ ...a })),
      })),
    };
    this.datasets.set(snapshot.datasetVersion, cloned);
  }

  pinFeedToDatasetVersion(feedId: string, datasetVersion: string): void {
    if (!this.datasets.has(datasetVersion)) {
      throw new Error(`Cannot pin feed "${feedId}" to unknown datasetVersion "${datasetVersion}"`);
    }
    this.feedPinnedVersion.set(feedId, datasetVersion);
  }

  /**
   * Dry-run diff between two dataset snapshots before promotion.
   */
  static diffDatasets(
    fromSnapshot: ReferenceDatasetSnapshot,
    toSnapshot: ReferenceDatasetSnapshot
  ): DatasetDiffReport {
    const fromMap = new Map(fromSnapshot.entities.map((e) => [e.canonicalId, e]));
    const toMap = new Map(toSnapshot.entities.map((e) => [e.canonicalId, e]));

    const addedCanonicalIds: string[] = [];
    const removedCanonicalIds: string[] = [];
    const retiredCanonicalIds: string[] = [];
    const aliasChanges: string[] = [];

    for (const [id, toEntity] of toMap.entries()) {
      const fromEntity = fromMap.get(id);
      if (!fromEntity) {
        addedCanonicalIds.push(id);
        continue;
      }
      if (fromEntity.effectiveToMs === undefined && toEntity.effectiveToMs !== undefined) {
        retiredCanonicalIds.push(id);
      }
      const fromAliases = fromEntity.aliases
        .map((a) => `${a.providerId}:${a.nativeId}:${a.chain ?? ""}:${a.contractAddress ?? ""}`)
        .sort()
        .join("|");
      const toAliases = toEntity.aliases
        .map((a) => `${a.providerId}:${a.nativeId}:${a.chain ?? ""}:${a.contractAddress ?? ""}`)
        .sort()
        .join("|");
      if (fromAliases !== toAliases) {
        aliasChanges.push(id);
      }
    }

    for (const id of fromMap.keys()) {
      if (!toMap.has(id)) {
        removedCanonicalIds.push(id);
      }
    }

    return {
      fromVersion: fromSnapshot.datasetVersion,
      toVersion: toSnapshot.datasetVersion,
      addedCanonicalIds,
      removedCanonicalIds,
      retiredCanonicalIds,
      aliasChanges,
    };
  }

  /**
   * Resolves and validates an incoming provider reading's entity reference against
   * the feed's pinned dataset version. Rejects unknown, retired, or ambiguous entities
   * into the dead-letter path so they are never counted toward consensus quorum.
   */
  validateAndResolveEntity(query: EntityResolutionQuery): EntityValidationResult {
    const observedAtMs = query.observedAtMs ?? query.eventTimestampMs;
    const version =
      query.pinnedDatasetVersion ?? this.feedPinnedVersion.get(query.feedId) ?? "";
    const dataset = this.datasets.get(version);

    if (!dataset) {
      return this.rejectToDeadLetter(
        query,
        version || "unpinned",
        "pinned_version_not_found",
        `Dataset version "${version || "unpinned"}" not found for feed "${query.feedId}"`,
        observedAtMs
      );
    }

    const normalizedRaw = query.rawIdentifier.trim();
    const candidates = dataset.entities.filter((entity) => {
      if (entity.kind !== query.kind) return false;

      // Match by canonicalId, provider-specific alias, or code
      const matchesCanonical = entity.canonicalId === normalizedRaw;
      const matchesProviderAlias = entity.aliases.some(
        (a) =>
          (a.providerId === query.providerId || a.providerId === "*") &&
          a.nativeId.toUpperCase() === normalizedRaw.toUpperCase()
      );
      const matchesCode = entity.code.toUpperCase() === normalizedRaw.toUpperCase();

      if (!matchesCanonical && !matchesProviderAlias && !matchesCode) {
        return false;
      }

      if (query.chain && entity.chain && query.chain.toLowerCase() !== entity.chain.toLowerCase()) {
        return false;
      }
      if (
        query.contractAddress &&
        entity.contractAddress &&
        query.contractAddress.toLowerCase() !== entity.contractAddress.toLowerCase()
      ) {
        return false;
      }
      return true;
    });

    if (candidates.length === 0) {
      return this.rejectToDeadLetter(
        query,
        version,
        "unknown_entity",
        `Unknown ${query.kind} entity "${query.rawIdentifier}" from provider "${query.providerId}"`,
        observedAtMs
      );
    }

    if (candidates.length > 1) {
      return this.rejectToDeadLetter(
        query,
        version,
        "ambiguous_entity_collision",
        `Ambiguous ${query.kind} identifier "${query.rawIdentifier}" matched ${candidates.length} entities (${candidates.map((c) => c.canonicalId).join(", ")}); specify chain and contractAddress`,
        observedAtMs
      );
    }

    let matched = candidates[0];
    // Follow rename chain if entity was renamed to a successor within the same dataset
    if (matched.renamedToCanonicalId) {
      const successor = dataset.entities.find(
        (e) => e.canonicalId === matched.renamedToCanonicalId
      );
      if (
        successor &&
        query.eventTimestampMs >= successor.effectiveFromMs &&
        (matched.effectiveToMs === undefined || query.eventTimestampMs > matched.effectiveToMs)
      ) {
        matched = successor;
      }
    }

    if (query.eventTimestampMs < matched.effectiveFromMs) {
      return this.rejectToDeadLetter(
        query,
        version,
        "not_yet_effective",
        `Entity "${matched.canonicalId}" is not effective until ${matched.effectiveFromMs} (eventTimestampMs=${query.eventTimestampMs})`,
        observedAtMs
      );
    }

    if (
      matched.effectiveToMs !== undefined &&
      query.eventTimestampMs > matched.effectiveToMs
    ) {
      return this.rejectToDeadLetter(
        query,
        version,
        "retired_entity",
        `Entity "${matched.canonicalId}" was retired at ${matched.effectiveToMs} before eventTimestampMs=${query.eventTimestampMs}`,
        observedAtMs
      );
    }

    return {
      valid: true,
      canonicalId: matched.canonicalId,
      datasetVersion: version,
      entity: matched,
      alertEmitted: false,
    };
  }

  getDeadLetters(): readonly DeadLetterEntityRecord[] {
    return this.deadLetters;
  }

  private rejectToDeadLetter(
    query: EntityResolutionQuery,
    datasetVersion: string,
    reason: DeadLetterReason,
    detail: string,
    observedAtMs: number
  ): EntityValidationResult {
    const deadLetter: DeadLetterEntityRecord = {
      feedId: query.feedId,
      datasetVersion,
      providerId: query.providerId,
      rawIdentifier: query.rawIdentifier,
      reason,
      detail,
      observedAtMs,
    };
    this.deadLetters.push(deadLetter);

    const recentAlerts = (this.alertTimestampsByFeed.get(query.feedId) ?? []).filter(
      (ts) => observedAtMs - ts <= this.alertWindowMs
    );
    let alertEmitted = false;
    if (recentAlerts.length < this.maxAlertsPerWindow) {
      recentAlerts.push(observedAtMs);
      alertEmitted = true;
    }
    this.alertTimestampsByFeed.set(query.feedId, recentAlerts);

    return {
      valid: false,
      datasetVersion,
      deadLetter,
      alertEmitted,
    };
  }
}
