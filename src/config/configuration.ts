import { registerAs } from '@nestjs/config';

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
 * Feeds whose readings are validated against the versioned reference data
 * registry. Each feed pins an explicit dataset version so a dataset refresh
 * can never retroactively change how a past reading was interpreted.
 */
export const REFERENCE_DATA_FEEDS = [
  'flightdelay',
  'liquidationshield',
  'price',
  'tvl',
] as const;

export type ReferenceDataFeed = (typeof REFERENCE_DATA_FEEDS)[number];

/**
 * Environment variable name holding the pinned dataset version for a feed,
 * e.g. REFERENCE_DATA_PIN_FLIGHTDELAY=2024-06-01.1.
 */
export function referenceDataPinEnvVar(feed: ReferenceDataFeed): string {
  return `REFERENCE_DATA_PIN_${feed.toUpperCase()}`;
}

/**
 * When true, a feed without an explicit pin may fall back to the latest
 * active dataset version. Off by default: the registry fails closed so an
 * unpinned feed cannot silently start validating against a newer dataset.
 */
export function allowLatestReferenceData(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.REFERENCE_DATA_ALLOW_LATEST ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

/**
 * Reads the pinned dataset version for a feed from the environment.
 * Returns null when no pin is configured (callers must decide whether the
 * latest-active fallback is permitted).
 */
export function pinnedReferenceDataVersion(
  feed: ReferenceDataFeed,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = (env[referenceDataPinEnvVar(feed)] ?? '').trim();
  return raw.length > 0 ? raw : null;
}

/**
 * Resolves the dataset version a feed must validate against.
 *
 * Fails closed: if the feed has no explicit pin and the latest-active
 * fallback has not been explicitly allowed, this throws so the process
 * cannot start (or ingest) with an ambiguous reference dataset.
 */
export function resolveReferenceDataVersion(
  feed: ReferenceDataFeed,
  latestActiveVersion: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const pinned = pinnedReferenceDataVersion(feed, env);
  if (pinned) {
    return pinned;
  }

  if (allowLatestReferenceData(env) && latestActiveVersion) {
    return latestActiveVersion;
  }

  throw new Error(
    `No reference data version pinned for feed "${feed}". Set ` +
      `${referenceDataPinEnvVar(feed)} to an explicit dataset version, or set ` +
      `REFERENCE_DATA_ALLOW_LATEST=true to explicitly allow falling back to the ` +
      `latest active dataset version.`,
  );
}

export default registerAs('app', () => ({
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  sandboxMode: isSandboxMode(),
}));

export const referenceDataConfig = registerAs('referenceData', () => ({
  allowLatest: allowLatestReferenceData(),
  pins: REFERENCE_DATA_FEEDS.reduce<Record<string, string | null>>((acc, feed) => {
    acc[feed] = pinnedReferenceDataVersion(feed);
    return acc;
  }, {}),
}));
