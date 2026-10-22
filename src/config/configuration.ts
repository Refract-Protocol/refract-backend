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

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = (env[key] ?? '').trim();
  if (raw === '') {
    return fallback;
  }
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = (env[key] ?? '').trim().toLowerCase();
  if (raw === '') {
    return fallback;
  }
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

function envList(env: NodeJS.ProcessEnv, key: string, fallback: string[]): string[] {
  const raw = (env[key] ?? '').trim();
  if (raw === '') {
    return fallback;
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Alert routing configuration (issue #289).
 *
 * The routing layer fingerprints, deduplicates, groups, escalates and
 * auto-resolves oracle alerts. All durations are in milliseconds.
 */
export function alertRoutingConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    enabled: envBool(env, 'ALERT_ROUTING_ENABLED', true),
    // Window in which identical fingerprints collapse into one incident.
    dedupWindowMs: envInt(env, 'ALERT_DEDUP_WINDOW_MS', 5 * 60 * 1000),
    // Window in which related alerts group into a single feed-outage incident.
    groupingWindowMs: envInt(env, 'ALERT_GROUPING_WINDOW_MS', 10 * 60 * 1000),
    // Delay before an unacknowledged incident escalates to secondary on-call.
    escalationDelayMs: envInt(env, 'ALERT_ESCALATION_DELAY_MS', 15 * 60 * 1000),
    // Interval between re-notifications while an incident stays unacknowledged.
    renotifyIntervalMs: envInt(env, 'ALERT_RENOTIFY_INTERVAL_MS', 10 * 60 * 1000),
    // Notifier adapter selection (e.g. 'webhook', 'log', 'noop').
    notifier: (env.ALERT_NOTIFIER ?? 'log').trim().toLowerCase(),
    // Webhook endpoint used by the webhook notifier adapter.
    webhookUrl: (env.ALERT_WEBHOOK_URL ?? '').trim(),
    // Secondary on-call target for escalated incidents.
    secondaryOnCall: (env.ALERT_SECONDARY_ONCALL ?? '').trim(),
  };
}

/**
 * Dead-man's-switch / watchdog configuration (issue #290).
 *
 * The heartbeat is emitted only after a successful poll cycle and DB write.
 * All durations are in milliseconds.
 */
export function heartbeatConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    enabled: envBool(env, 'HEARTBEAT_ENABLED', false),
    url: (env.HEARTBEAT_URL ?? '').trim(),
    // Expected cadence between heartbeats.
    intervalMs: envInt(env, 'HEARTBEAT_INTERVAL_MS', 60 * 1000),
    // Grace period before a missed heartbeat is considered a failure.
    gracePeriodMs: envInt(env, 'HEARTBEAT_GRACE_PERIOD_MS', 5 * 60 * 1000),
    // Consecutive misses required before paging (transient failures ignored).
    maxConsecutiveMisses: envInt(env, 'HEARTBEAT_MAX_CONSECUTIVE_MISSES', 3),
    // Local watchdog: max age of a successful metrics scrape.
    metricsStalenessThresholdMs: envInt(
      env,
      'WATCHDOG_METRICS_STALENESS_MS',
      5 * 60 * 1000,
    ),
    // Local watchdog: max age of a successful alert delivery.
    alertDeliveryStalenessThresholdMs: envInt(
      env,
      'WATCHDOG_ALERT_DELIVERY_STALENESS_MS',
      15 * 60 * 1000,
    ),
  };
}

/**
 * Manual override preview configuration (issue #299).
 *
 * Enforced server-side so the CLI cannot bypass the exposure ceiling or the
 * preview validity window.
 */
export function overridePreviewConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    enabled: envBool(env, 'OVERRIDE_PREVIEW_ENABLED', true),
    // How long a preview token stays valid for applying an override.
    validityWindowMs: envInt(env, 'OVERRIDE_PREVIEW_VALIDITY_MS', 10 * 60 * 1000),
    // Maximum aggregate payout exposure allowed without extra approval.
    exposureCeiling: envInt(env, 'OVERRIDE_EXPOSURE_CEILING', 100_000),
    // Maximum number of policies scanned during an interactive preview.
    maxPolicyScan: envInt(env, 'OVERRIDE_PREVIEW_MAX_POLICY_SCAN', 1000),
    // Roles permitted to generate a preview.
    previewRoles: envList(env, 'OVERRIDE_PREVIEW_ROLES', ['operator', 'admin']),
    // Roles permitted to apply an override (must have previewed first).
    applyRoles: envList(env, 'OVERRIDE_APPLY_ROLES', ['admin']),
  };
}

export default registerAs('app', () => ({
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  sandboxMode: isSandboxMode(),
  alertRouting: alertRoutingConfig(),
  heartbeat: heartbeatConfig(),
  overridePreview: overridePreviewConfig(),
}));
