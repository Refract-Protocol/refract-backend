export interface RawWindowReading {
  sourceId: string;
  canonicalWindowTs: number;
  payloadHash: string;
  normalizedValue: number;
  receivedAtMs: number;
}

export interface DeduplicationResult {
  deduplicatedReadings: RawWindowReading[];
  collapsedDuplicateCount: number;
  conflictingSources: string[];
}

export class SourceReadingDeduplicator {
  public deduplicateWindowReadings(readings: RawWindowReading[]): DeduplicationResult {
    const bySourceAndWindow = new Map<string, RawWindowReading[]>();
    for (const r of readings) {
      const key = `${r.sourceId}::${r.canonicalWindowTs}`;
      if (!bySourceAndWindow.has(key)) {
        bySourceAndWindow.set(key, []);
      }
      bySourceAndWindow.get(key)!.push(r);
    }

    const deduplicatedReadings: RawWindowReading[] = [];
    let collapsedDuplicateCount = 0;
    const conflictingSources = new Set<string>();

    for (const group of bySourceAndWindow.values()) {
      const sorted = [...group].sort((a, b) => a.receivedAtMs - b.receivedAtMs);
      const primary = sorted[0];
      let hasConflict = false;

      for (let i = 1; i < sorted.length; i++) {
        if (
          sorted[i].payloadHash === primary.payloadHash &&
          sorted[i].normalizedValue === primary.normalizedValue
        ) {
          collapsedDuplicateCount++;
        } else {
          hasConflict = true;
        }
      }

      if (hasConflict) {
        conflictingSources.add(primary.sourceId);
      } else {
        deduplicatedReadings.push(primary);
      }
    }

    return {
      deduplicatedReadings,
      collapsedDuplicateCount,
      conflictingSources: Array.from(conflictingSources).sort(),
    };
  }
}
