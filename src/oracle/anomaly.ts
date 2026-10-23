import { Inject, Injectable, Logger } from "@nestjs/common";
import { OracleReading } from "./oracle-reading";

/** Injection token for the data-driven rule set, so thresholds can be tuned without a redeploy. */
export const ANOMALY_RULES = Symbol("ANOMALY_RULES");

/**
 * Plausibility rules for one coverage type. Every bound is optional; an
 * unset bound is not checked.
 */
export interface AnomalyRule {
  /** Inclusive sanity floor for the raw reading. */
  floor?: number;
  /** Inclusive sanity ceiling for the raw reading. */
  ceiling?: number;
  /** Reject an exact zero reading (a zeroed feed is a parse or upstream failure). */
  rejectZero?: boolean;
  /** Max absolute % move between the oldest accepted reading inside windowMs and the current one. */
  maxPctChange?: number;
  windowMs?: number;
}

export type AnomalyRules = Record<string, AnomalyRule>;

export interface AnomalyVerdict {
  triggered: boolean;
  reasons: string[];
}

/** Illustrative defaults. Override via the ANOMALY_RULES provider. */
export const DEFAULT_ANOMALY_RULES: AnomalyRules = {
  StablecoinDepeg: { floor: 0.5, ceiling: 1.5, rejectZero: true, maxPctChange: 5, windowMs: 5 * 60_000 },
  MarketCrash: { floor: -100, ceiling: 100, rejectZero: false },
  LiquidationShield: { floor: 0, ceiling: 1, rejectZero: true },
  SmartContractRisk: { floor: -100, ceiling: 100, rejectZero: false },
  FlightDelay: { floor: 0, ceiling: 2880, rejectZero: false },
};

interface Sample {
  at: number;
  value: number;
}

@Injectable()
export class AnomalyDetector {
  private readonly logger = new Logger(AnomalyDetector.name);

  /** Accepted readings only, so a rejected spike never becomes the baseline. */
  private readonly history = new Map<string, Sample[]>();

  constructor(@Inject(ANOMALY_RULES) private readonly rules: AnomalyRules) {}

  /** Fails closed: any error while evaluating rules is itself a trigger. */
  evaluate(reading: OracleReading, now = Date.now()): AnomalyVerdict {
    try {
      return this.check(reading, now);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Anomaly evaluation failed for ${reading.coverageType}: ${message}`);
      return { triggered: true, reasons: [`rule evaluation error: ${message}`] };
    }
  }

  private check(reading: OracleReading, now: number): AnomalyVerdict {
    const rule = this.rules[reading.coverageType];
    if (!rule) {
      return { triggered: true, reasons: [`no anomaly rule configured for ${reading.coverageType}`] };
    }

    const value = reading.value;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { triggered: true, reasons: [`null or non-finite reading (${String(value)})`] };
    }

    const reasons: string[] = [];
    if (rule.rejectZero && value === 0) {
      reasons.push("zero reading rejected");
    }
    if (rule.floor !== undefined && value < rule.floor) {
      reasons.push(`value ${value} below floor ${rule.floor}`);
    }
    if (rule.ceiling !== undefined && value > rule.ceiling) {
      reasons.push(`value ${value} above ceiling ${rule.ceiling}`);
    }
    if (rule.maxPctChange !== undefined && rule.windowMs !== undefined) {
      const change = this.pctChangeWithinWindow(reading.coverageType, value, now, rule.windowMs);
      if (change !== null && Math.abs(change) > rule.maxPctChange) {
        reasons.push(`${change.toFixed(2)}% change within ${rule.windowMs}ms exceeds ${rule.maxPctChange}%`);
      }
    }

    if (reasons.length > 0) {
      return { triggered: true, reasons };
    }

    this.remember(reading.coverageType, value, now, rule.windowMs);
    return { triggered: false, reasons };
  }

  /** Change from the oldest accepted sample inside the window to `value`; null when there is no baseline. */
  private pctChangeWithinWindow(key: string, value: number, now: number, windowMs: number): number | null {
    const baseline = (this.history.get(key) ?? []).find((s) => s.at >= now - windowMs);
    if (!baseline) return null;
    if (baseline.value === 0) return value === 0 ? 0 : Infinity;
    return ((value - baseline.value) / Math.abs(baseline.value)) * 100;
  }

  private remember(key: string, value: number, now: number, windowMs: number | undefined): void {
    if (windowMs === undefined) return;
    const samples = (this.history.get(key) ?? []).filter((s) => s.at >= now - windowMs);
    samples.push({ at: now, value });
    this.history.set(key, samples);
  }
}
