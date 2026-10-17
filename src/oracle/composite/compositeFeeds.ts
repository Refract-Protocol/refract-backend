/**
 * Versioned Composite and Derived Feeds Built from Upstream Consensus Feeds (Issue #298)
 *
 * Evaluates non-Turing-complete fixed-point AST formulas deterministically over
 * upstream consensus decisions, enforces topological ordering and cycle rejection,
 * inherits the weakest upstream trust/freshness state, and emits reproducible
 * evidence records pinning formula versions and input decision IDs.
 */

export type FixedPointRoundingMode = "floor" | "ceil" | "half_up";

export type UpstreamTrustState = "healthy" | "degraded" | "quarantined";

export type CompositeEvaluationStatus =
  | "healthy"
  | "degraded"
  | "suspended_stale_input"
  | "suspended_quarantined_input"
  | "evaluation_error";

export interface CompositeInputRequirement {
  feedId: string;
  /** Maximum age (ms) of the upstream consensus decision relative to evaluation time */
  maxFreshnessAgeMs: number;
}

export type CompositeAstNode =
  | { kind: "constant"; valueScaled: bigint }
  | { kind: "input"; feedId: string }
  | {
      kind: "binary";
      op: "add" | "sub" | "mul" | "div" | "abs_diff" | "min" | "max";
      left: CompositeAstNode;
      right: CompositeAstNode;
    };

export interface CompositeFeedDefinition {
  feedId: string;
  version: number;
  unit: string;
  /** Fixed-point decimal scale (e.g. 7 for 10^7 stroops/bps, 4 for 10^4 bps) */
  scaleDecimals: number;
  roundingMode: FixedPointRoundingMode;
  inputs: CompositeInputRequirement[];
  formula: CompositeAstNode;
}

export interface UpstreamConsensusDecision {
  feedId: string;
  decisionId: string;
  /** Fixed-point value scaled to the composite's `scaleDecimals` */
  valueScaled: bigint;
  decidedAtMs: number;
  trustState: UpstreamTrustState;
}

export interface CompositeEvidenceRecord {
  outputFeedId: string;
  formulaVersion: number;
  unit: string;
  scaleDecimals: number;
  status: CompositeEvaluationStatus;
  computedValueScaled: bigint | null;
  inputDecisionIds: Record<string, string>;
  evaluatedAtMs: number;
  errorDetail?: string;
}

function pow10BigInt(decimals: number): bigint {
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new Error(`Invalid scaleDecimals: ${decimals}`);
  }
  return 10n ** BigInt(decimals);
}

function divideWithRounding(
  numerator: bigint,
  denominator: bigint,
  mode: FixedPointRoundingMode
): bigint {
  if (denominator === 0n) {
    throw new Error("Division by zero in composite formula");
  }
  const neg = (numerator < 0n) !== (denominator < 0n);
  const absNum = numerator < 0n ? -numerator : numerator;
  const absDen = denominator < 0n ? -denominator : denominator;
  const quotient = absNum / absDen;
  const remainder = absNum % absDen;

  if (remainder === 0n) {
    return neg ? -quotient : quotient;
  }

  if (mode === "floor") {
    return neg ? -(quotient + 1n) : quotient;
  }
  if (mode === "ceil") {
    return neg ? -quotient : quotient + 1n;
  }
  // half_up
  const twiceRem = remainder * 2n;
  const roundedAbs = twiceRem >= absDen ? quotient + 1n : quotient;
  return neg ? -roundedAbs : roundedAbs;
}

function collectAstInputRefs(node: CompositeAstNode, acc = new Set<string>()): Set<string> {
  if (node.kind === "input") {
    acc.add(node.feedId);
  } else if (node.kind === "binary") {
    collectAstInputRefs(node.left, acc);
    collectAstInputRefs(node.right, acc);
  }
  return acc;
}

export class CompositeFeedRegistry {
  private readonly definitionsByFeed = new Map<string, Map<number, CompositeFeedDefinition>>();
  private readonly activeVersionByFeed = new Map<string, number>();

  /**
   * Registers a versioned composite feed definition after validating units,
   * input references, self-references, and DAG acyclicity.
   */
  registerCompositeFeed(def: CompositeFeedDefinition): void {
    if (!def.feedId || def.feedId.trim() === "") {
      throw new Error("Composite feedId must be non-empty");
    }
    if (!def.unit || def.unit.trim() === "") {
      throw new Error(`Composite feed "${def.feedId}": unit must be defined`);
    }
    if (def.version <= 0 || !Number.isInteger(def.version)) {
      throw new Error(`Composite feed "${def.feedId}": version must be a positive integer`);
    }
    if (def.inputs.length === 0) {
      throw new Error(`Composite feed "${def.feedId}": inputs cannot be empty`);
    }

    const declaredInputs = new Set(def.inputs.map((i) => i.feedId));
    if (declaredInputs.has(def.feedId)) {
      throw new Error(`Composite feed "${def.feedId}" cannot reference itself`);
    }

    const astInputs = collectAstInputRefs(def.formula);
    for (const ref of astInputs) {
      if (!declaredInputs.has(ref)) {
        throw new Error(
          `Composite feed "${def.feedId}" AST references undeclared input feed "${ref}"`
        );
      }
    }

    const versions = this.definitionsByFeed.get(def.feedId) ?? new Map<number, CompositeFeedDefinition>();
    if (versions.has(def.version)) {
      throw new Error(
        `Composite feed "${def.feedId}" version ${def.version} is immutable and already registered`
      );
    }

    // Tentatively stage to verify DAG has no cycles across active composites
    versions.set(def.version, def);
    this.definitionsByFeed.set(def.feedId, versions);
    const prevActive = this.activeVersionByFeed.get(def.feedId);
    this.activeVersionByFeed.set(def.feedId, def.version);

    try {
      this.resolveTopologicalOrder();
    } catch (err) {
      versions.delete(def.version);
      if (prevActive !== undefined) {
        this.activeVersionByFeed.set(def.feedId, prevActive);
      } else {
        this.activeVersionByFeed.delete(def.feedId);
      }
      throw err;
    }
  }

  /**
   * Resolves a deterministic topological evaluation order across all active composite feeds.
   * Throws if any dependency cycle exists.
   */
  resolveTopologicalOrder(): string[] {
    const activeDefs = new Map<string, CompositeFeedDefinition>();
    for (const [feedId, ver] of this.activeVersionByFeed.entries()) {
      const def = this.definitionsByFeed.get(feedId)?.get(ver);
      if (def) {
        activeDefs.set(feedId, def);
      }
    }

    const visited = new Map<string, "visiting" | "visited">();
    const order: string[] = [];

    const visit = (feedId: string, path: string[]) => {
      const state = visited.get(feedId);
      if (state === "visiting") {
        throw new Error(
          `Dependency cycle detected in composite feeds: ${[...path, feedId].join(" -> ")}`
        );
      }
      if (state === "visited") {
        return;
      }
      visited.set(feedId, "visiting");
      const def = activeDefs.get(feedId);
      if (def) {
        for (const inp of def.inputs) {
          if (activeDefs.has(inp.feedId)) {
            visit(inp.feedId, [...path, feedId]);
          }
        }
      }
      visited.set(feedId, "visited");
      order.push(feedId);
    };

    for (const feedId of Array.from(activeDefs.keys()).sort()) {
      visit(feedId, []);
    }

    return order;
  }

  /**
   * Evaluates a specific composite feed (using the active version or an explicit historical version for replay).
   */
  evaluateComposite(
    feedId: string,
    upstreamDecisions: Readonly<Record<string, UpstreamConsensusDecision | undefined>>,
    evaluatedAtMs: number,
    explicitVersion?: number
  ): CompositeEvidenceRecord {
    const version = explicitVersion ?? this.activeVersionByFeed.get(feedId);
    const def = version !== undefined ? this.definitionsByFeed.get(feedId)?.get(version) : undefined;
    if (!def || version === undefined) {
      throw new Error(`Composite feed "${feedId}" version ${String(version)} not found`);
    }

    const inputDecisionIds: Record<string, string> = {};
    let inheritedStatus: CompositeEvaluationStatus = "healthy";

    for (const req of def.inputs) {
      const upstream = upstreamDecisions[req.feedId];
      if (!upstream) {
        return {
          outputFeedId: def.feedId,
          formulaVersion: def.version,
          unit: def.unit,
          scaleDecimals: def.scaleDecimals,
          status: "suspended_stale_input",
          computedValueScaled: null,
          inputDecisionIds,
          evaluatedAtMs,
          errorDetail: `Required upstream consensus decision "${req.feedId}" is missing`,
        };
      }

      inputDecisionIds[req.feedId] = upstream.decisionId;

      if (upstream.trustState === "quarantined") {
        return {
          outputFeedId: def.feedId,
          formulaVersion: def.version,
          unit: def.unit,
          scaleDecimals: def.scaleDecimals,
          status: "suspended_quarantined_input",
          computedValueScaled: null,
          inputDecisionIds,
          evaluatedAtMs,
          errorDetail: `Upstream feed "${req.feedId}" is in quarantined trust state`,
        };
      }

      const ageMs = evaluatedAtMs - upstream.decidedAtMs;
      if (ageMs > req.maxFreshnessAgeMs) {
        return {
          outputFeedId: def.feedId,
          formulaVersion: def.version,
          unit: def.unit,
          scaleDecimals: def.scaleDecimals,
          status: "suspended_stale_input",
          computedValueScaled: null,
          inputDecisionIds,
          evaluatedAtMs,
          errorDetail: `Upstream feed "${req.feedId}" decision age (${ageMs}ms) exceeds maxFreshnessAgeMs (${req.maxFreshnessAgeMs}ms)`,
        };
      }

      if (upstream.trustState === "degraded") {
        inheritedStatus = "degraded";
      }
    }

    const scaleFactor = pow10BigInt(def.scaleDecimals);

    try {
      const computedValueScaled = this.evalNode(
        def.formula,
        upstreamDecisions,
        scaleFactor,
        def.roundingMode
      );
      return {
        outputFeedId: def.feedId,
        formulaVersion: def.version,
        unit: def.unit,
        scaleDecimals: def.scaleDecimals,
        status: inheritedStatus,
        computedValueScaled,
        inputDecisionIds,
        evaluatedAtMs,
      };
    } catch (err) {
      return {
        outputFeedId: def.feedId,
        formulaVersion: def.version,
        unit: def.unit,
        scaleDecimals: def.scaleDecimals,
        status: "evaluation_error",
        computedValueScaled: null,
        inputDecisionIds,
        evaluatedAtMs,
        errorDetail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Evaluates all active composite feeds in topological order so composites of composites
   * automatically consume newly computed upstream composite decisions.
   */
  evaluateAllActiveComposites(
    initialUpstreamDecisions: Readonly<Record<string, UpstreamConsensusDecision | undefined>>,
    evaluatedAtMs: number
  ): Record<string, CompositeEvidenceRecord> {
    const order = this.resolveTopologicalOrder();
    const workingDecisions: Record<string, UpstreamConsensusDecision | undefined> = {
      ...initialUpstreamDecisions,
    };
    const results: Record<string, CompositeEvidenceRecord> = {};

    for (const feedId of order) {
      const record = this.evaluateComposite(feedId, workingDecisions, evaluatedAtMs);
      results[feedId] = record;

      if (
        record.computedValueScaled !== null &&
        (record.status === "healthy" || record.status === "degraded")
      ) {
        workingDecisions[feedId] = {
          feedId,
          decisionId: `comp_${feedId}_v${record.formulaVersion}_${evaluatedAtMs}`,
          valueScaled: record.computedValueScaled,
          decidedAtMs: evaluatedAtMs,
          trustState: record.status === "degraded" ? "degraded" : "healthy",
        };
      }
    }

    return results;
  }

  private evalNode(
    node: CompositeAstNode,
    upstreamDecisions: Readonly<Record<string, UpstreamConsensusDecision | undefined>>,
    scaleFactor: bigint,
    roundingMode: FixedPointRoundingMode
  ): bigint {
    if (node.kind === "constant") {
      return node.valueScaled;
    }
    if (node.kind === "input") {
      const up = upstreamDecisions[node.feedId];
      if (!up) {
        throw new Error(`Missing upstream input "${node.feedId}"`);
      }
      return up.valueScaled;
    }

    const left = this.evalNode(node.left, upstreamDecisions, scaleFactor, roundingMode);
    const right = this.evalNode(node.right, upstreamDecisions, scaleFactor, roundingMode);

    switch (node.op) {
      case "add":
        return left + right;
      case "sub":
        return left - right;
      case "abs_diff":
        return left >= right ? left - right : right - left;
      case "min":
        return left <= right ? left : right;
      case "max":
        return left >= right ? left : right;
      case "mul":
        return divideWithRounding(left * right, scaleFactor, roundingMode);
      case "div":
        return divideWithRounding(left * scaleFactor, right, roundingMode);
    }
  }
}
