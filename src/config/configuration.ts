import { registerAs } from '@nestjs/config';
import {
  AttackCostModelError,
  evaluateExposureBound,
  type AttackCostModel,
  type FeedAttackInput,
} from '../security/attack-cost-model';

/**
 * Resolves the sandbox-mode flag from the environment.
 *
 * Sandbox mode swaps every real backing service (Postgres repositories,
 * Redis cache, Soroban RPC calls) for lightweight in-memory/mocked
 * equivalents so a fresh clone can run with `npm install && npm run dev`
 * and no other setup.
 *
 * Safety: sandbox mode is a contributor-onboarding tool only. It must never
 * be reachable from a deployed environment, so we refuse to enable it when
 * NODE_ENV=production (see assertSandboxSafety below).
 */
export function isSandboxMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.SANDBOX_MODE ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

/**
 * Boot-time safety check: refuse to start in sandbox mode when running in a
 * production-configured deployment, even if SANDBOX_MODE was set by accident.
 * Throws so the process fails fast rather than silently serving mocked data.
 */
export function assertSandboxSafety(env: NodeJS.ProcessEnv = process.env): void {
  if (!isSandboxMode(env)) {
    return;
  }

  const nodeEnv = (env.NODE_ENV ?? '').trim().toLowerCase();
  if (nodeEnv === 'production') {
    throw new Error(
      'SANDBOX_MODE is enabled but NODE_ENV=production. Sandbox mode is a ' +
        'local contributor-onboarding tool and must never run in a deployed ' +
        'environment. Unset SANDBOX_MODE or set NODE_ENV to a non-production value.',
    );
  }
}

/**
 * Prominent startup banner so sandbox mode is never mistaken for a real
 * environment. Returns the lines to log; callers decide how to emit them.
 */
export function sandboxStartupBanner(): string[] {
  return [
    '============================================================',
    '  SANDBOX MODE ENABLED — NOT A REAL ENVIRONMENT',
    '  Postgres, Redis, and Soroban RPC are replaced with',
    '  in-memory mocks. All data resets on restart.',
    '  Do not use this mode outside local development.',
    '============================================================',
  ];
}

/**
 * A payout-triggering feed together with the quorum policy that governs it.
 * `exposure` is the maximum payout the feed can trigger (in stroops, as a
 * decimal string so large values survive JSON/env parsing without precision
 * loss). `independenceWeights` maps each source to its independence weight in
 * [0, 1]; sources omitted from the map are treated as fully dependent
 * (weight 0), i.e. worst case.
 */
export interface FeedExposureConfig extends FeedAttackInput {
  /** Human-readable feed identifier used in error messages. */
  id: string;
  /** Maximum payout exposure the feed can trigger, as a decimal string. */
  exposure: string;
  /** True when the feed can trigger a payout (subject to the bound check). */
  payoutTriggering?: boolean;
}

export interface AttackCostValidationConfig {
  /** Safety factor: modeled attack cost must be >= exposure * safetyFactor. */
  safetyFactor: string;
  /** The attack-cost model to evaluate against (versioned alongside policy). */
  model: AttackCostModel;
  /** Feed definitions plus their quorum policies. */
  feeds: FeedExposureConfig[];
}

/**
 * Boot-time validation: refuse to start when a payout-triggering feed's
 * exposure exceeds the modeled attack cost by the configured safety factor.
 *
 * Throws an Error listing the offending feed, its exposure, the modeled
 * attack cost, and the safety factor so operators can see exactly which
 * parameter needs to change.
 */
export function assertAttackCostCoverage(
  config: AttackCostValidationConfig,
): void {
  const violations: string[] = [];

  for (const feed of config.feeds) {
    if (feed.payoutTriggering === false) {
      continue;
    }

    let result;
    try {
      result = evaluateExposureBound(feed, config.model, config.safetyFactor);
    } catch (err) {
      if (err instanceof AttackCostModelError) {
        throw new Error(
          `Attack-cost model rejected feed "${feed.id}": ${err.message}`,
        );
      }
      throw err;
    }

    if (!result.satisfied) {
      violations.push(
        `feed "${feed.id}": exposure ${feed.exposure} exceeds modeled ` +
          `attack cost ${result.attackCost} by safety factor ` +
          `${config.safetyFactor} (max supported exposure ` +
          `${result.maxSupportedExposure})`,
      );
    }
  }

  if (violations.length > 0) {
    throw new Error(
      'Attack-cost coverage validation failed. Refusing to start because ' +
        'payout-triggering feed exposure exceeds the modeled attack cost:\n  ' +
        violations.join('\n  '),
    );
  }
}

export default registerAs('app', () => ({
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  sandboxMode: isSandboxMode(),
}));
