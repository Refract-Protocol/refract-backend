import { OracleReading } from "./oracle-reading";

export const MIN_ORACLE_INTERVAL_MS = 15_000;
export const BASE_ORACLE_INTERVAL_MS = 60_000;
export const MAX_ORACLE_INTERVAL_MS = 300_000;

export function calculateOracleIntervalMs(
  reading: OracleReading,
  previousValue: number | undefined,
  quotaPressure: number,
): number {
  const thresholdMagnitude = Math.max(Math.abs(reading.threshold), 1);
  let urgency = 1;
  let quietMultiplier = 1;

  if (!reading.degraded) {
    const distance = Math.abs(reading.value - reading.threshold) / thresholdMagnitude;
    if (distance <= 0.05) urgency = 0.25;
    else if (distance <= 0.2) urgency = 0.5;

    if (previousValue !== undefined) {
      const volatility = Math.abs(reading.value - previousValue) / thresholdMagnitude;
      if (volatility >= 0.25) urgency = Math.min(urgency, 0.25);
      else if (volatility >= 0.1) urgency = Math.min(urgency, 0.5);
      else if (volatility >= 0.025) urgency = Math.min(urgency, 0.75);
      else if (distance > 0.2) quietMultiplier = 2;
    }
  }

  const pressure = Number.isFinite(quotaPressure)
    ? Math.max(0, Math.min(1, quotaPressure))
    : 0;
  const interval = BASE_ORACLE_INTERVAL_MS * urgency * quietMultiplier * (1 + 2 * pressure);
  return Math.max(MIN_ORACLE_INTERVAL_MS, Math.min(MAX_ORACLE_INTERVAL_MS, Math.round(interval)));
}
