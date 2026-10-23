import { ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { payloadHash, sha256Hex } from "./canonical";
import { foldHolds } from "./claim-hold.service";
import { EVIDENCE_LEDGER, PAYLOAD_STORE, positiveInt } from "./consensus.config";
import { SOURCE_CREDENTIAL_STORE, SourceCredentialStore } from "./credential-store";
import { EvidenceLedger, PayloadStore } from "./evidence-ledger";
import { EvidenceEvent, OffboardingStartedEvent } from "./evidence.types";
import { decisionById, latestSourceVersionNumber, policyAt, sourcesAt, sourceVersionAt } from "./ledger-view";

const DAY_MS = 86_400_000;

export type RetainReason = "within_license_retention" | "open_dispute" | "shared_with_active_source";

export interface OffboardingPlan {
  sourceId: string;
  providerId: string;
  feedId: string;
  generatedAt: string;
  alreadyRetired: boolean;
  /** Source version that will carry status `retired`. */
  retireAsVersion: number | null;
  credential: { credentialRef: string; action: "revoke" | "already_revoked" } | null;
  quorum: {
    policyVersion: number | null;
    minSources: number | null;
    remainingEligibleSources: number;
    dropsBelowQuorum: boolean;
  };
  openDisputes: { holdId: string; policyId: string; status: string }[];
  payloads: {
    purge: { hash: string; storedAt: string }[];
    retain: { hash: string; storedAt: string; reason: RetainReason; purgeAfter: string | null }[];
    alreadyPurged: number;
  };
  /** Evidence that stays in the ledger no matter what is purged. */
  preserved: { readings: number; decisions: number; payloadHashes: number };
}

/**
 * Pure dry-run: what offboarding `sourceId` at `now` would do. It reads only
 * the ledger, so the dry run and the real run see exactly the same plan,
 * and the CLI and the API produce the same report.
 *
 * Payload retention rules, in priority order:
 *  1. bodies referenced by a decision behind an open hold are kept (dispute);
 *  2. bodies also referenced by another non-retired source are kept;
 *  3. bodies younger than the source licence's `retentionDays` are kept
 *     until `purgeAfter`; the retention sweep purges them later;
 *  4. everything else is purged.
 */
export function planOffboarding(events: readonly EvidenceEvent[], sourceId: string, now: number): OffboardingPlan {
  const current = sourceVersionAt(events, sourceId, Number.POSITIVE_INFINITY);
  if (!current) throw new NotFoundException(`unknown source ${sourceId}`);
  const alreadyRetired = current.status === "retired";
  // The licence terms that apply are those of the last non-retired version.
  const licensed = [...events]
    .reverse()
    .find((e) => e.kind === "source_version" && e.sourceId === sourceId && e.status !== "retired");
  const retentionDays = licensed && licensed.kind === "source_version" ? licensed.retentionDays : current.retentionDays;
  const credentialRef = licensed && licensed.kind === "source_version" ? licensed.credentialRef : current.credentialRef;

  // Quorum impact
  const policy = policyAt(events, current.feedId, now);
  const remaining = sourcesAt(events, current.feedId, now).filter(
    (s) => s.sourceId !== sourceId && (s.status === "active" || s.status === "warmup") && s.weight > 0,
  ).length;

  // Open disputes: non-terminal holds whose decisions used this source.
  const disputedHashes = new Set<string>();
  const readingHash = new Map<string, string | null>();
  for (const e of events) if (e.kind === "reading") readingHash.set(e.readingId, e.payloadHash);
  const openDisputes: OffboardingPlan["openDisputes"] = [];
  for (const hold of foldHolds(events).values()) {
    if (hold.status === "settled" || hold.status === "denied") continue;
    const decisionIds = new Set([hold.decisionId, hold.currentDecisionId]);
    let involved = false;
    for (const id of decisionIds) {
      for (const c of decisionById(events, id)?.contributing ?? []) {
        const h = readingHash.get(c.readingId);
        if (h) disputedHashes.add(h);
        if (c.sourceId === sourceId) involved = true;
      }
    }
    if (involved) openDisputes.push({ holdId: hold.holdId, policyId: hold.policyId, status: hold.status });
  }

  // Hashes referenced by other sources that are not retired.
  const otherStatus = new Map<string, string>();
  const sharedHashes = new Set<string>();
  for (const e of events) {
    if (e.kind === "source_version") otherStatus.set(e.sourceId, e.status);
  }
  for (const e of events) {
    if (e.kind === "reading" && e.sourceId !== sourceId && e.payloadHash && otherStatus.get(e.sourceId) !== "retired") {
      sharedHashes.add(e.payloadHash);
    }
  }

  const purged = new Set(events.flatMap((e) => (e.kind === "payload_purged" ? [e.hash] : [])));
  const stored = new Map<string, number>();
  for (const e of events) {
    if (e.kind === "payload_stored" && !stored.has(e.hash)) stored.set(e.hash, e.recordedAt);
  }
  // Every hash this source's readings reference (whoever stored it first).
  const sourceHashes = new Set<string>();
  for (const e of events) if (e.kind === "reading" && e.sourceId === sourceId && e.payloadHash) sourceHashes.add(e.payloadHash);
  for (const e of events) if (e.kind === "payload_stored" && e.sourceId === sourceId) sourceHashes.add(e.hash);

  const plan: OffboardingPlan["payloads"] = { purge: [], retain: [], alreadyPurged: 0 };
  for (const hash of [...sourceHashes].sort()) {
    if (purged.has(hash)) {
      plan.alreadyPurged++;
      continue;
    }
    const storedAt = stored.get(hash);
    if (storedAt === undefined) continue;
    const iso = new Date(storedAt).toISOString();
    const purgeAfter = storedAt + retentionDays * DAY_MS;
    if (disputedHashes.has(hash)) {
      plan.retain.push({ hash, storedAt: iso, reason: "open_dispute", purgeAfter: null });
    } else if (sharedHashes.has(hash)) {
      plan.retain.push({ hash, storedAt: iso, reason: "shared_with_active_source", purgeAfter: null });
    } else if (now < purgeAfter) {
      plan.retain.push({ hash, storedAt: iso, reason: "within_license_retention", purgeAfter: new Date(purgeAfter).toISOString() });
    } else {
      plan.purge.push({ hash, storedAt: iso });
    }
  }

  const revoked = events.some(
    (e) => e.kind === "credential_revoked" && e.sourceId === sourceId && e.credentialRef === credentialRef,
  );

  return {
    sourceId,
    providerId: current.providerId,
    feedId: current.feedId,
    generatedAt: new Date(now).toISOString(),
    alreadyRetired,
    retireAsVersion: alreadyRetired ? null : latestSourceVersionNumber(events, sourceId) + 1,
    credential: credentialRef ? { credentialRef, action: revoked ? "already_revoked" : "revoke" } : null,
    quorum: {
      policyVersion: policy?.version ?? null,
      minSources: policy?.minSources ?? null,
      remainingEligibleSources: remaining,
      dropsBelowQuorum: !alreadyRetired && policy !== null && remaining < policy.minSources,
    },
    openDisputes,
    payloads: plan,
    preserved: {
      readings: events.filter((e) => e.kind === "reading" && e.sourceId === sourceId).length,
      decisions: events.filter((e) => e.kind === "decision" && e.contributing.some((c) => c.sourceId === sourceId)).length,
      payloadHashes: sourceHashes.size,
    },
  };
}

export interface OffboardingOptions {
  actor: string;
  reason: string;
  dryRun?: boolean;
  /** Required to retire a source whose removal drops the feed below quorum. */
  acknowledgeQuorumLoss?: boolean;
}

export interface OffboardingReport {
  dryRun: boolean;
  offboardingId: string | null;
  plan: OffboardingPlan;
  executed: { retired: boolean; credentialRevoked: boolean; purged: number } | null;
}

/**
 * Retires a source and purges its licence-restricted payload bodies, while
 * keeping every hash, derived value and decision reference in the ledger.
 *
 * Each step is recorded once it is done, so a run that fails part-way can
 * simply be re-run: finished steps are skipped and the rest resume under
 * the same offboarding id.
 */
@Injectable()
export class OffboardingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OffboardingService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(EVIDENCE_LEDGER) private readonly ledger: EvidenceLedger,
    @Inject(PAYLOAD_STORE) private readonly payloads: PayloadStore,
    @Inject(SOURCE_CREDENTIAL_STORE) private readonly credentials: SourceCredentialStore,
  ) {}

  onModuleInit(): void {
    const every = positiveInt(process.env.OFFBOARDING_RETENTION_SWEEP_INTERVAL_MS, 60 * 60 * 1000);
    this.timer = setInterval(() => void this.sweepRetention(), every);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  plan(sourceId: string): OffboardingPlan {
    return planOffboarding(this.ledger.events(), sourceId, this.ledger.now());
  }

  async offboard(sourceId: string, opts: OffboardingOptions): Promise<OffboardingReport> {
    const plan = this.plan(sourceId);
    if (opts.dryRun) return { dryRun: true, offboardingId: null, plan, executed: null };

    if (plan.quorum.dropsBelowQuorum && !opts.acknowledgeQuorumLoss) {
      throw new ConflictException({
        message: `retiring ${sourceId} leaves ${plan.quorum.remainingEligibleSources} eligible source(s); policy v${plan.quorum.policyVersion} requires ${plan.quorum.minSources}. Re-run with acknowledgeQuorumLoss once a replacement is planned.`,
        plan,
      });
    }

    const offboardingId = this.resumableRun(sourceId) ?? this.start(sourceId, plan, opts);
    const executed = { retired: false, credentialRevoked: false, purged: 0 };

    // (a) Retire: a new source version, never a delete.
    if (!plan.alreadyRetired) {
      const current = sourceVersionAt(this.ledger.events(), sourceId, Number.POSITIVE_INFINITY)!;
      const at = this.ledger.reserveTimestamp();
      this.ledger.append({
        ...stripMeta(current),
        kind: "source_version",
        version: latestSourceVersionNumber(this.ledger.events(), sourceId) + 1,
        status: "retired",
        warmupUntil: undefined,
        credentialRef: undefined,
        effectiveFrom: at,
        recordedAt: at,
      });
      executed.retired = true;
    }

    // (b) Revoke and delete stored credentials.
    if (plan.credential?.action === "revoke") {
      await this.step(offboardingId, "credential", () => this.credentials.delete(plan.credential!.credentialRef));
      this.ledger.append({ kind: "credential_revoked", offboardingId, sourceId, credentialRef: plan.credential.credentialRef });
      executed.credentialRevoked = true;
    }

    // (c) Purge bodies beyond licence retention. Hashes and references stay.
    executed.purged = await this.purge(offboardingId, sourceId, plan);

    // (d) Completion record.
    const after = this.plan(sourceId);
    this.ledger.append({
      kind: "offboarding_completed",
      offboardingId,
      sourceId,
      purged: after.payloads.alreadyPurged,
      retained: after.payloads.retain.length,
    });
    this.ledger.append({
      kind: "audit",
      action: "source.offboarding_completed",
      actor: opts.actor,
      reason: opts.reason,
      details: { offboardingId, sourceId, purgedThisRun: executed.purged, retained: after.payloads.retain },
    });
    this.logger.log(`Source ${sourceId} offboarded (${offboardingId}): purged ${executed.purged}, retained ${after.payloads.retain.length}`);
    return { dryRun: false, offboardingId, plan, executed };
  }

  /**
   * Purges bodies of retired sources whose retention has since lapsed or
   * whose dispute has closed. Runs on a schedule. Each source runs independently.
   */
  async sweepRetention(): Promise<number> {
    let total = 0;
    const retired = new Set<string>();
    for (const e of this.ledger.events()) {
      if (e.kind === "source_version") (e.status === "retired" ? retired.add(e.sourceId) : retired.delete(e.sourceId));
    }
    for (const sourceId of retired) {
      try {
        const plan = this.plan(sourceId);
        if (plan.payloads.purge.length === 0) continue;
        const run = this.lastRun(sourceId);
        if (!run) continue;
        total += await this.purge(run, sourceId, plan);
      } catch (err) {
        this.logger.error(`Retention sweep failed for ${sourceId}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return total;
  }

  /** Verifies a payload hash: is the body still held, does it match, was it purged and why. */
  payloadStatus(hash: string) {
    const events = this.ledger.events();
    const stored = events.find((e) => e.kind === "payload_stored" && e.hash === hash);
    if (!stored) throw new NotFoundException(`unknown payload ${hash}`);
    const purged = events.find((e) => e.kind === "payload_purged" && e.hash === hash);
    const body = this.payloads.get(hash);
    return {
      hash,
      storedAt: new Date(stored.recordedAt).toISOString(),
      available: body !== undefined,
      bodyMatchesHash: body === undefined ? null : payloadHash(body) === hash,
      purged: purged && purged.kind === "payload_purged" ? { at: new Date(purged.recordedAt).toISOString(), reason: purged.reason, offboardingId: purged.offboardingId } : null,
      referencedByReadings: events.filter((e) => e.kind === "reading" && e.payloadHash === hash).map((e) => (e.kind === "reading" ? e.readingId : "")),
    };
  }

  private async purge(offboardingId: string, sourceId: string, plan: OffboardingPlan): Promise<number> {
    let n = 0;
    for (const { hash } of plan.payloads.purge) {
      await this.step(offboardingId, `purge ${hash}`, async () => this.payloads.delete(hash));
      this.ledger.append({ kind: "payload_purged", hash, sourceId, offboardingId, reason: "beyond licence retention after offboarding" });
      n++;
    }
    return n;
  }

  private start(sourceId: string, plan: OffboardingPlan, opts: OffboardingOptions): string {
    const offboardingId = `ob_${sha256Hex(`${sourceId}:${this.ledger.now()}:${this.ledger.events().length}`).slice(0, 20)}`;
    this.ledger.append({
      kind: "offboarding_started",
      offboardingId,
      sourceId,
      actor: opts.actor,
      reason: opts.reason,
      purgeScope: plan.payloads.purge.map((p) => p.hash),
      retained: plan.payloads.retain.map((r) => ({ hash: r.hash, reason: r.reason })),
    });
    this.ledger.append({
      kind: "audit",
      action: "source.offboarding_started",
      actor: opts.actor,
      reason: opts.reason,
      details: {
        offboardingId,
        sourceId,
        feedId: plan.feedId,
        purgeScope: plan.payloads.purge.length,
        retained: plan.payloads.retain.length,
        openDisputes: plan.openDisputes.map((d) => d.holdId),
        quorum: plan.quorum,
        credentialRef: plan.credential?.credentialRef ?? null,
      },
    });
    return offboardingId;
  }

  private async step(offboardingId: string, what: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.ledger.append({
        kind: "audit",
        action: "source.offboarding_failed",
        actor: "system",
        reason: `${what}: ${msg}`,
        details: { offboardingId, resumable: true },
      });
      throw new ConflictException({ message: `offboarding ${offboardingId} stopped at "${what}": ${msg}. Re-run to resume.` });
    }
  }

  /** An offboarding that started and never completed, to resume. */
  private resumableRun(sourceId: string): string | null {
    const run = this.lastRun(sourceId);
    if (!run) return null;
    const completed = this.ledger.events().some((e) => e.kind === "offboarding_completed" && e.offboardingId === run);
    return completed ? null : run;
  }

  private lastRun(sourceId: string): string | null {
    let last: OffboardingStartedEvent | null = null;
    for (const e of this.ledger.events()) if (e.kind === "offboarding_started" && e.sourceId === sourceId) last = e;
    return last?.offboardingId ?? null;
  }
}

function stripMeta<T extends { seq: number; recordedAt: number }>(e: T): Omit<T, "seq" | "recordedAt"> {
  const { seq: _seq, recordedAt: _recordedAt, ...rest } = e;
  return rest;
}
