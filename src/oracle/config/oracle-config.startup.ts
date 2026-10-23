import { LoadedOracleConfig, loadOracleConfig } from "./oracle-feed-config";
import { OracleConfigReport, formatReport, validateOracleConfig } from "./oracle-config.validator";

export class OracleConfigInvalidError extends Error {
  constructor(
    message: string,
    readonly report?: OracleConfigReport
  ) {
    super(message);
  }
}

export interface StartupLogger {
  log(message: string): void;
  warn(message: string): void;
}

export interface ValidatedOracleConfig extends LoadedOracleConfig {
  report: OracleConfigReport;
}

const truthy = (value: string | undefined): boolean =>
  ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());

/**
 * Loads and validates the oracle feed config. Call it before the Nest app is
 * created, so a bad config stops the process before any poller, publisher,
 * or claim settler starts.
 *
 * Throws {@link OracleConfigInvalidError} on any error, or on any warning
 * when `ORACLE_CONFIG_STRICT=true`.
 */
export function assertOracleConfigAtStartup(
  env: NodeJS.ProcessEnv = process.env,
  logger?: StartupLogger
): ValidatedOracleConfig {
  let loaded: LoadedOracleConfig;
  try {
    loaded = loadOracleConfig(env);
  } catch (error) {
    throw new OracleConfigInvalidError(error instanceof Error ? error.message : String(error));
  }

  const report = validateOracleConfig(loaded.config, {
    network: env.STELLAR_NETWORK ?? "testnet",
    env,
  });
  const summary = formatReport(report, loaded.origin);
  const strict = truthy(env.ORACLE_CONFIG_STRICT);

  if (report.errors.length > 0 || (strict && report.warnings.length > 0)) {
    throw new OracleConfigInvalidError(
      `Refusing to start: oracle feed config is invalid${strict && report.errors.length === 0 ? " (ORACLE_CONFIG_STRICT treats warnings as errors)" : ""}.\n${summary}`,
      report
    );
  }

  if (report.warnings.length > 0) logger?.warn(summary);
  else logger?.log(summary);

  return { ...loaded, report };
}
