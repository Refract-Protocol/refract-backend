export interface OperatorFeedState {
  feedId: string;
  trustMode: "single" | "corroborated" | "decentralized";
  paused: boolean;
  sources: Array<{ sourceId: string; quarantined: boolean }>;
}

export interface OperatorReadingRecord {
  feedId: string;
  sourceId: string;
  value: number;
  observedAtMs: number;
}

export interface OperatorDecisionRecord {
  decisionId: string;
  feedId: string;
  consensusValue: number;
  evidenceLinks: string[];
  decidedAtMs: number;
}

export interface OperatorAuditRecord {
  action:
    | "feed:pause"
    | "feed:resume"
    | "source:quarantine"
    | "source:unquarantine";
  targetId: string;
  operator: string;
  reason: string;
  timestampMs: number;
}

export interface CliExecutionResult {
  exitCode: number;
  dryRun: boolean;
  output: unknown;
  error?: string;
}

export class OracleOperatorCli {
  private readonly feeds = new Map<string, OperatorFeedState>();
  private readonly readings: OperatorReadingRecord[] = [];
  private readonly decisions: OperatorDecisionRecord[] = [];
  private readonly auditLog: OperatorAuditRecord[] = [];

  public seedFeed(feed: OperatorFeedState): void {
    this.feeds.set(feed.feedId, {
      ...feed,
      sources: feed.sources.map((s) => ({ ...s })),
    });
  }

  public seedReading(reading: OperatorReadingRecord): void {
    this.readings.push({ ...reading });
  }

  public seedDecision(decision: OperatorDecisionRecord): void {
    this.decisions.push({
      ...decision,
      evidenceLinks: [...decision.evidenceLinks],
    });
  }

  public getAuditLog(): OperatorAuditRecord[] {
    return [...this.auditLog];
  }

  public execute(
    args: {
      command:
        | "feeds:list"
        | "readings:recent"
        | "decisions:recent"
        | "feed:pause"
        | "feed:resume"
        | "source:quarantine"
        | "source:unquarantine";
      feedId?: string;
      sourceId?: string;
      operator?: string;
      reason?: string;
      confirm?: boolean;
      dryRun?: boolean;
      nowMs?: number;
    }
  ): CliExecutionResult {
    const dryRun = Boolean(args.dryRun);
    const nowMs = args.nowMs ?? Date.now();

    if (args.command === "feeds:list") {
      return {
        exitCode: 0,
        dryRun: false,
        output: Array.from(this.feeds.values()),
      };
    }

    if (args.command === "readings:recent") {
      if (!args.feedId) {
        return {
          exitCode: 1,
          dryRun: false,
          output: null,
          error: "Missing --feed argument",
        };
      }
      const grouped: Record<string, OperatorReadingRecord[]> = {};
      for (const r of this.readings.filter((x) => x.feedId === args.feedId)) {
        grouped[r.sourceId] = grouped[r.sourceId] ?? [];
        grouped[r.sourceId].push(r);
      }
      return { exitCode: 0, dryRun: false, output: grouped };
    }

    if (args.command === "decisions:recent") {
      if (!args.feedId) {
        return {
          exitCode: 1,
          dryRun: false,
          output: null,
          error: "Missing --feed argument",
        };
      }
      return {
        exitCode: 0,
        dryRun: false,
        output: this.decisions.filter((d) => d.feedId === args.feedId),
      };
    }

    // Mutating commands require operator identity, rationale, and either --dry-run or --confirm
    if (!args.operator || !args.reason) {
      return {
        exitCode: 1,
        dryRun,
        output: null,
        error: "Mutating commands require --operator and --reason",
      };
    }

    if (!dryRun && !args.confirm) {
      return {
        exitCode: 1,
        dryRun: false,
        output: null,
        error:
          "High-impact mutation requires --confirm (or --dry-run to preview)",
      };
    }

    if (args.command === "feed:pause" || args.command === "feed:resume") {
      const feed = args.feedId ? this.feeds.get(args.feedId) : undefined;
      if (!feed) {
        return {
          exitCode: 1,
          dryRun,
          output: null,
          error: `Unknown feed '${args.feedId ?? ""}'`,
        };
      }
      const nextPaused = args.command === "feed:pause";
      if (dryRun) {
        return {
          exitCode: 0,
          dryRun: true,
          output: { ...feed, paused: nextPaused },
        };
      }
      feed.paused = nextPaused;
      this.auditLog.push({
        action: args.command,
        targetId: feed.feedId,
        operator: args.operator,
        reason: args.reason,
        timestampMs: nowMs,
      });
      return { exitCode: 0, dryRun: false, output: { ...feed } };
    }

    if (
      args.command === "source:quarantine" ||
      args.command === "source:unquarantine"
    ) {
      const feed = args.feedId ? this.feeds.get(args.feedId) : undefined;
      const source = feed?.sources.find((s) => s.sourceId === args.sourceId);
      if (!feed || !source) {
        return {
          exitCode: 1,
          dryRun,
          output: null,
          error: `Unknown feed/source '${args.feedId ?? ""}/${args.sourceId ?? ""}'`,
        };
      }
      const nextQuarantined = args.command === "source:quarantine";
      if (dryRun) {
        return {
          exitCode: 0,
          dryRun: true,
          output: {
            feedId: feed.feedId,
            sourceId: source.sourceId,
            quarantined: nextQuarantined,
          },
        };
      }
      source.quarantined = nextQuarantined;
      this.auditLog.push({
        action: args.command,
        targetId: `${feed.feedId}:${source.sourceId}`,
        operator: args.operator,
        reason: args.reason,
        timestampMs: nowMs,
      });
      return {
        exitCode: 0,
        dryRun: false,
        output: {
          feedId: feed.feedId,
          sourceId: source.sourceId,
          quarantined: source.quarantined,
        },
      };
    }

    return {
      exitCode: 1,
      dryRun,
      output: null,
      error: "Unsupported command",
    };
  }
}
