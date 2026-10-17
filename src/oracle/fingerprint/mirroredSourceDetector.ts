import { createHash } from "node:crypto";

export interface SourceReadingSample {
  sourceId: string;
  windowTimestampMs: number;
  normalizedValue: number;
  rawPayload: Record<string, unknown>;
}

export interface MirrorDetectionConfig {
  minSamples: number;
  exactMatchThreshold: number;
  nearMatchValueToleranceBps: number;
  mirroredIndependenceWeightCap: number;
}

export interface SourcePairSimilarity {
  sourceA: string;
  sourceB: string;
  commonWindows: number;
  exactPayloadMatchRatio: number;
  nearValueMatchRatio: number;
  isMirrored: boolean;
}

export class MirroredSourceDetector {
  private readonly config: MirrorDetectionConfig;

  constructor(config: MirrorDetectionConfig) {
    this.config = config;
  }

  public computeCanonicalPayloadFingerprint(rawPayload: Record<string, unknown>): string {
    const volatileKeys = new Set(["timestamp", "ts", "requestId", "request_id", "nonce", "receivedAt"]);
    const canonicalize = (val: unknown): unknown => {
      if (Array.isArray(val)) return val.map(canonicalize);
      if (val !== null && typeof val === "object") {
        const obj = val as Record<string, unknown>;
        return Object.keys(obj)
          .filter((k) => !volatileKeys.has(k))
          .sort()
          .reduce<Record<string, unknown>>((acc, k) => {
            acc[k] = canonicalize(obj[k]);
            return acc;
          }, {});
      }
      return val;
    };
    const canonicalJson = JSON.stringify(canonicalize(rawPayload));
    return createHash("sha256").update(canonicalJson).digest("hex");
  }

  public evaluatePairs(samples: SourceReadingSample[]): {
    pairs: SourcePairSimilarity[];
    effectiveIndependenceWeights: Record<string, number>;
  } {
    const bySource = new Map<string, Map<number, { fingerprint: string; value: number }>>();
    for (const s of samples) {
      if (!bySource.has(s.sourceId)) {
        bySource.set(s.sourceId, new Map());
      }
      bySource.get(s.sourceId)!.set(s.windowTimestampMs, {
        fingerprint: this.computeCanonicalPayloadFingerprint(s.rawPayload),
        value: s.normalizedValue,
      });
    }

    const sources = Array.from(bySource.keys()).sort();
    const pairs: SourcePairSimilarity[] = [];
    const effectiveIndependenceWeights: Record<string, number> = {};
    for (const src of sources) {
      effectiveIndependenceWeights[src] = 1.0;
    }

    for (let i = 0; i < sources.length; i++) {
      for (let j = i + 1; j < sources.length; j++) {
        const sourceA = sources[i];
        const sourceB = sources[j];
        const mapA = bySource.get(sourceA)!;
        const mapB = bySource.get(sourceB)!;

        let commonWindows = 0;
        let exactMatches = 0;
        let nearValueMatches = 0;

        for (const [windowTs, entryA] of mapA.entries()) {
          const entryB = mapB.get(windowTs);
          if (!entryB) continue;
          commonWindows++;
          if (entryA.fingerprint === entryB.fingerprint) {
            exactMatches++;
          }
          const denom = Math.max(Math.abs(entryA.value), 1e-9);
          const diffBps = (Math.abs(entryA.value - entryB.value) / denom) * 10_000;
          if (diffBps <= this.config.nearMatchValueToleranceBps) {
            nearValueMatches++;
          }
        }

        const exactPayloadMatchRatio = commonWindows > 0 ? exactMatches / commonWindows : 0;
        const nearValueMatchRatio = commonWindows > 0 ? nearValueMatches / commonWindows : 0;
        const isMirrored =
          commonWindows >= this.config.minSamples &&
          (exactPayloadMatchRatio >= this.config.exactMatchThreshold ||
            nearValueMatchRatio >= this.config.exactMatchThreshold);

        if (isMirrored) {
          effectiveIndependenceWeights[sourceB] = Math.min(
            effectiveIndependenceWeights[sourceB],
            this.config.mirroredIndependenceWeightCap
          );
        }

        pairs.push({
          sourceA,
          sourceB,
          commonWindows,
          exactPayloadMatchRatio,
          nearValueMatchRatio,
          isMirrored,
        });
      }
    }

    return { pairs, effectiveIndependenceWeights };
  }
}
