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

export default registerAs('app', () => ({
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  sandboxMode: isSandboxMode(),
}));
