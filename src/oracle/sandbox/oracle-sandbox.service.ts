import { randomUUID } from "crypto";
import { Injectable, Logger } from "@nestjs/common";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { corroborate, CorroborationInput, CorroborationOutcome } from "./corroboration";
import { loadOracleSandboxConfig, OracleSandboxConfig, SANDBOX_FEEDS } from "./oracle-sandbox.config";
import {
  ProviderReadingSubmission,
  validateSubmissionShape,
  verifyReadingSignature,
} from "./provider-submission";

export type RejectionReason =
  | "invalid_shape"
  | "unknown_feed"
  | "unregistered_provider"
  | "stale"
  | "from_future"
  | "replayed_nonce"
  | "rate_limited"
  | "bad_signature"
  | "outlier"
  | "insufficient_agreement";

export interface SandboxRejection {
  id: string;
  at: string;
  reason: RejectionReason;
  detail: string;
  submissionId?: string;
  providerId?: string;
  feed?: string;
  decisionId?: string;
}

export interface SandboxDecision {
  id: string;
  at: string;
  feed: string;
  status: "accepted" | "rejected";
  value: number | null;
  median: number;
  tolerance: number;
  agreeingProviders: string[];
  outlierProviders: string[];
  submissionIds: string[];
  reason?: string;
  /** Always false. Sandbox decisions are never sent on-chain. */
  published: false;
}

export interface SandboxProvider {
  providerId: string;
  name: string;
  registeredAt: string;
}

export interface SubmissionTrace {
  submissionId: string;
  status: "rejected" | "awaiting_corroboration" | "decided";
  rejection?: SandboxRejection;
  corroboration?: { providers: number; required: number };
  decision?: SandboxDecision;
}

export const REGISTRATION_MESSAGE_VERSION = "refract-oracle-provider-registration:v1";

export function registrationMessage(providerId: string, name: string): string {
  return [REGISTRATION_MESSAGE_VERSION, "sandbox", providerId, name].join("\n");
}

interface StoredReading extends CorroborationInput {
  feed: string;
}

/**
 * In-memory provider sandbox. Every submission runs the same steps a
 * production submission would: shape check, provider registry, freshness,
 * replay protection, signature, then corroboration. Each step's outcome can
 * be inspected afterwards.
 *
 * It holds no database or Redis handle and no relayer, so nothing it does
 * can reach production feeds or the chain. State resets on restart.
 */
@Injectable()
export class OracleSandboxService {
  private readonly logger = new Logger(OracleSandboxService.name);
  private readonly providers = new Map<string, SandboxProvider>();
  private readonly readings = new Map<string, StoredReading[]>();
  /** providerId → nonce → expiry ms. */
  private readonly nonces = new Map<string, Map<string, number>>();
  /** providerId → timestamps of accepted-for-processing submissions in the last minute. */
  private readonly recentSubmissions = new Map<string, number[]>();
  private readonly decisions: SandboxDecision[] = [];
  private readonly rejections: SandboxRejection[] = [];

  constructor(
    private readonly config: OracleSandboxConfig = loadOracleSandboxConfig(),
    private readonly now: () => number = Date.now,
  ) {}

  feeds(): readonly string[] {
    return SANDBOX_FEEDS;
  }

  policy(): OracleSandboxConfig["policy"] & { feedAbsoluteTolerance: Record<string, number> } {
    return { ...this.config.policy, feedAbsoluteTolerance: this.config.feedAbsoluteTolerance };
  }

  /**
   * Registers a provider key. The caller signs the registration message with
   * the key's secret, which proves they own it.
   */
  registerProvider(input: unknown): SandboxProvider {
    const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    const providerId = typeof raw.providerId === "string" ? raw.providerId : "";
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const signature = typeof raw.signature === "string" ? raw.signature : "";

    if (!StrKey.isValidEd25519PublicKey(providerId)) {
      throw new SandboxInputError("providerId must be a Stellar public key (G…)");
    }
    if (name.length < 1 || name.length > 64) {
      throw new SandboxInputError("name must be 1-64 characters");
    }
    let ok = false;
    try {
      ok = Keypair.fromPublicKey(providerId).verify(
        Buffer.from(registrationMessage(providerId, name), "utf8"),
        Buffer.from(signature, "base64"),
      );
    } catch {
      ok = false;
    }
    if (!ok) {
      throw new SandboxInputError(
        "signature does not verify; sign the registration message with the provider's secret key",
      );
    }

    const existing = this.providers.get(providerId);
    if (existing) return existing;
    if (this.providers.size >= this.config.maxProviders) {
      throw new SandboxInputError("sandbox provider limit reached; try again after the next reset");
    }
    const provider = { providerId, name, registeredAt: new Date(this.now()).toISOString() };
    this.providers.set(providerId, provider);
    this.logger.log(`Sandbox provider registered: ${name} (${providerId.slice(0, 8)}…)`);
    return provider;
  }

  listProviders(): SandboxProvider[] {
    return [...this.providers.values()];
  }

  submit(input: unknown): SubmissionTrace {
    const submissionId = randomUUID();
    const nowMs = this.now();
    this.purgeExpired(nowMs);
    const { submission, problems } = validateSubmissionShape(input);
    if (!submission) {
      return this.reject(submissionId, "invalid_shape", problems.join("; "));
    }
    const ctx = { providerId: submission.providerId, feed: submission.feed };

    if (!(SANDBOX_FEEDS as readonly string[]).includes(submission.feed)) {
      return this.reject(submissionId, "unknown_feed", `feed must be one of: ${SANDBOX_FEEDS.join(", ")}`, ctx);
    }
    if (!this.providers.has(submission.providerId)) {
      return this.reject(
        submissionId,
        "unregistered_provider",
        "register the provider key first (POST /sandbox/oracle/providers)",
        ctx,
      );
    }

    const observedAtMs = Date.parse(submission.observedAt);
    if (observedAtMs > nowMs + this.config.maxFutureSkewMs) {
      return this.reject(submissionId, "from_future", "observedAt is ahead of server time", ctx);
    }
    if (observedAtMs < nowMs - this.config.policy.windowMs) {
      return this.reject(
        submissionId,
        "stale",
        `observedAt is older than the ${this.config.policy.windowMs}ms corroboration window`,
        ctx,
      );
    }

    // Verify the signature before recording the nonce, so a forged request
    // can't burn a real provider's nonce.
    if (!verifyReadingSignature("sandbox", submission)) {
      return this.reject(
        submissionId,
        "bad_signature",
        'signature does not verify against providerId for domain "sandbox"',
        ctx,
      );
    }
    // Counted after the signature check, so forged requests can't use up a
    // real provider's quota.
    if (!this.withinRateLimit(submission.providerId, nowMs)) {
      return this.reject(
        submissionId,
        "rate_limited",
        `more than ${this.config.maxSubmissionsPerMinute} submissions in the last minute`,
        ctx,
      );
    }
    if (!this.consumeNonce(submission, nowMs)) {
      return this.reject(submissionId, "replayed_nonce", "nonce was already used by this provider", ctx);
    }

    const feedReadings = this.pruneFeed(submission.feed, nowMs);
    feedReadings.push({
      submissionId,
      providerId: submission.providerId,
      feed: submission.feed,
      value: Number(submission.value),
      observedAtMs,
    });

    const outcome = corroborate(
      submission.feed,
      feedReadings,
      {
        ...this.config.policy,
        absoluteTolerance: this.config.feedAbsoluteTolerance[submission.feed] ?? 0,
      },
      nowMs,
    );

    if (outcome.status === "pending") {
      return {
        submissionId,
        status: "awaiting_corroboration",
        corroboration: { providers: outcome.providers, required: outcome.required },
      };
    }

    const decision = this.recordDecision(outcome);
    const ownOutlier = outcome.outliers.find((r) => r.submissionId === submissionId);
    return {
      submissionId,
      status: "decided",
      decision,
      ...(ownOutlier
        ? {
            rejection: this.rejections.find(
              (r) => r.submissionId === submissionId && r.decisionId === decision.id,
            ),
          }
        : {}),
    };
  }

  listDecisions(feed?: string, limit = 50): SandboxDecision[] {
    this.purgeExpired(this.now());
    return this.newestFirst(this.decisions, limit, (d) => !feed || d.feed === feed);
  }

  getDecision(id: string): SandboxDecision | undefined {
    return this.decisions.find((d) => d.id === id);
  }

  listRejections(filter: { providerId?: string; feed?: string } = {}, limit = 50): SandboxRejection[] {
    this.purgeExpired(this.now());
    return this.newestFirst(
      this.rejections,
      limit,
      (r) => (!filter.providerId || r.providerId === filter.providerId) && (!filter.feed || r.feed === filter.feed),
    );
  }

  /** Readings currently inside the corroboration window, for one feed. */
  feedState(feed: string): { feed: string; readings: Array<Omit<StoredReading, "feed">>; latestDecision?: SandboxDecision } {
    const readings = this.pruneFeed(feed, this.now()).map(({ feed: _f, ...rest }) => rest);
    return { feed, readings, latestDecision: this.listDecisions(feed, 1)[0] };
  }

  reset(): void {
    this.providers.clear();
    this.readings.clear();
    this.nonces.clear();
    this.recentSubmissions.clear();
    this.decisions.length = 0;
    this.rejections.length = 0;
  }

  private recordDecision(outcome: Exclude<CorroborationOutcome, { status: "pending" }>): SandboxDecision {
    const decision: SandboxDecision = {
      id: randomUUID(),
      at: new Date(this.now()).toISOString(),
      feed: outcome.feed,
      status: outcome.status,
      value: outcome.value,
      median: outcome.median,
      tolerance: outcome.tolerance,
      agreeingProviders: outcome.agreeing.map((r) => r.providerId),
      outlierProviders: outcome.outliers.map((r) => r.providerId),
      submissionIds: [...outcome.agreeing, ...outcome.outliers].map((r) => r.submissionId),
      reason: outcome.reason,
      published: false,
    };
    this.push(this.decisions, decision, this.config.maxStoredDecisions);

    for (const r of outcome.outliers) {
      this.pushRejection({
        reason: "outlier",
        detail: `value ${r.value} is outside median ${outcome.median} ± ${outcome.tolerance}`,
        submissionId: r.submissionId,
        providerId: r.providerId,
        feed: outcome.feed,
        decisionId: decision.id,
      });
    }
    if (outcome.status === "rejected") {
      this.pushRejection({
        reason: "insufficient_agreement",
        detail: `${outcome.agreeing.length} provider(s) agree; ${this.config.policy.minProviders} required`,
        feed: outcome.feed,
        decisionId: decision.id,
      });
    }
    return decision;
  }

  private reject(
    submissionId: string,
    reason: RejectionReason,
    detail: string,
    ctx: { providerId?: string; feed?: string } = {},
  ): SubmissionTrace {
    const rejection = this.pushRejection({ reason, detail, submissionId, ...ctx });
    return { submissionId, status: "rejected", rejection };
  }

  private pushRejection(r: Omit<SandboxRejection, "id" | "at">): SandboxRejection {
    const rejection = { id: randomUUID(), at: new Date(this.now()).toISOString(), ...r };
    this.push(this.rejections, rejection, this.config.maxStoredRejections);
    return rejection;
  }

  /** Drops decisions and rejections past ORACLE_SANDBOX_RETENTION_MS. */
  purgeExpired(nowMs: number): void {
    const cutoff = nowMs - this.config.retentionMs;
    const drop = <T extends { at: string }>(list: T[]) => {
      let n = 0;
      while (n < list.length && Date.parse(list[n].at) < cutoff) n++;
      if (n > 0) list.splice(0, n);
    };
    drop(this.decisions);
    drop(this.rejections);
  }

  private withinRateLimit(providerId: string, nowMs: number): boolean {
    const recent = (this.recentSubmissions.get(providerId) ?? []).filter((t) => t > nowMs - 60_000);
    if (recent.length >= this.config.maxSubmissionsPerMinute) {
      this.recentSubmissions.set(providerId, recent);
      return false;
    }
    recent.push(nowMs);
    this.recentSubmissions.set(providerId, recent);
    return true;
  }

  private consumeNonce(sub: ProviderReadingSubmission, nowMs: number): boolean {
    let seen = this.nonces.get(sub.providerId);
    if (!seen) {
      seen = new Map();
      this.nonces.set(sub.providerId, seen);
    }
    for (const [nonce, expiry] of seen) {
      if (expiry < nowMs) seen.delete(nonce);
    }
    if (seen.has(sub.nonce)) return false;
    // Any replay older than this would already fail the staleness check.
    seen.set(sub.nonce, nowMs + this.config.policy.windowMs + this.config.maxFutureSkewMs);
    return true;
  }

  private pruneFeed(feed: string, nowMs: number): StoredReading[] {
    const cutoff = nowMs - this.config.policy.windowMs;
    const kept = (this.readings.get(feed) ?? []).filter((r) => r.observedAtMs >= cutoff);
    this.readings.set(feed, kept);
    return kept;
  }

  private push<T>(list: T[], item: T, max: number): void {
    list.push(item);
    if (list.length > max) list.splice(0, list.length - max);
  }

  private newestFirst<T>(list: T[], limit: number, keep: (item: T) => boolean): T[] {
    const out: T[] = [];
    for (let i = list.length - 1; i >= 0 && out.length < limit; i--) {
      if (keep(list[i])) out.push(list[i]);
    }
    return out;
  }
}

export class SandboxInputError extends Error {}
