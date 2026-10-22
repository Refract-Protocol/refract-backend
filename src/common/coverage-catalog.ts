/**
 * Single source of truth for the five coverage products offered by Refract.
 *
 * Both QuoteService (GET /api/v1/quotes/coverage-types) and PolicyService
 * (GET /api/v1/policies/types) project their responses from this catalog, so
 * a product change updates both automatically.
 *
 * Reconciliation decisions (issue #59):
 * - riskLevel: policy's lowercase values win ("medium", "high", "critical",
 *   "low") — quote's "Low"/"Medium" casing was inconsistent with the rest of
 *   the catalog and with policy's client-facing output.
 * - riskMultiplier: both files agreed (1.0, 1.5, 2.0, 3.0, 0.8) — kept as-is.
 * - maxDuration: quote-only field, kept (policy never enforced a per-type
 *   duration cap).
 * - maxCoverage / baseRatePct: policy-only fields, kept (quote never enforced
 *   a per-type coverage cap).
 * - trigger: policy's trigger text wins where the two disagreed; quote's
 *   trigger text was a shorter paraphrase of the same condition.
 * - defaultTriggerThreshold: policy's TRIGGER_THRESHOLDS, in the units
 *   process_claim() compares against (see pool/src/lib.rs): bps for
 *   StablecoinDepeg/MarketCrash, minutes for FlightDelay.
 *   LiquidationShield/SmartContractRisk trigger on `oracle_value > 0` and
 *   never read trigger_threshold, so its value there is inert — kept
 *   non-zero only for consistency with the other entries.
 * - maxPoolExposurePct: per-coverage-type aggregate exposure cap (issue #134),
 *   expressed as a percentage of the pool's locked capital. Enforced at
 *   buy() time against the sum of currently-active coverage in that type so
 *   the pool cannot over-concentrate in a single risk category. Distinct from
 *   the per-policy maxCoverage cap and the pool-global on-chain bounds.
 *
 * Staged rollout (issue #131):
 * - Every product carries a `status` of `draft` or `live`. Newly staged
 *   products start as `draft` and are only visible to admins via the preview
 *   endpoint; they become publicly quotable/buyable only after an explicit
 *   publish transition. Public catalog reads (QuoteService, PolicyService)
 *   must filter to `live` products so a draft is never accidentally live.
 * - Each publish transition records an approval record (who drafted, who
 *   published, when) so the governance step is auditable.
 *
 * Composite / derived feeds (issue #298):
 * - A composite feed's value is computed deterministically from one or more
 *   upstream *consensus* feeds via a declared, versioned formula. Composites
 *   are first-class: they participate in the same scheduling, evidence,
 *   anomaly, and trust machinery as primitive feeds.
 * - Formulas are represented as a small, versioned, non-Turing-complete AST
 *   evaluated by a pure function over a fixed-decimal numeric type so results
 *   are reproducible byte-for-byte across nodes and replays.
 * - Composite evaluation only ever reads upstream *consensus* outputs (never
 *   raw single-source readings), with declared freshness requirements on each
 *   input. A composite inherits the weakest required input state (stale,
 *   quarantined, degraded) so a degraded input degrades the composite.
 * - Cycles, self-reference, and undefined units are rejected at config load;
 *   the dependency graph is resolved topologically so composites-of-composites
 *   evaluate in order.
 * - Every evaluation emits a consensus-quality decision + evidence record
 *   recording the formula version, input decision ids, and computed value so
 *   replay uses the version in force at the time.
 */
import { FixedDecimal, FixedDecimalError } from "./fixed-point";

export type CoverageType =
  | "StablecoinDepeg"
  | "MarketCrash"
  | "LiquidationShield"
  | "SmartContractRisk"
  | "FlightDelay";

/** Lifecycle state of a coverage product in the staged rollout workflow. */
export type CoverageStatus = "draft" | "live";

/**
 * Auditable record of a coverage-type publish event. Captures who staged the
 * draft and who performed the distinctly-authorized publish action, plus the
 * timestamps of each transition.
 */
export interface CoverageApprovalRecord {
  /** Admin actor that created the coverage type in `draft` state. */
  draftedBy: string;
  /** When the draft was created. */
  draftedAt: string;
  /** Admin actor that transitioned the draft to `live`. */
  publishedBy: string;
  /** When the publish transition occurred. */
  publishedAt: string;
}

export interface CoverageProduct {
  /** Canonical string identifier, matching the on-chain enum variant name. */
  id: CoverageType;
  /** Numeric on-chain index, matching pool/src/lib.rs's CoverageType order. */
  onChainIndex: number;
  /** Human-readable display name. */
  name: string;
  description: string;
  trigger: string;
  riskLevel: string;
  riskMultiplier: number;
  baseRatePct: number;
  maxCoverage: number;
  maxDuration: number;
  icon: string;
  defaultTriggerThreshold: number;
  /**
   * Maximum aggregate active coverage for this type, as a percentage of the
   * pool's locked capital (issue #134). Configurable via the coverage-type
   * admin API; enforced at buy() time against the sum of active coverage.
   */
  maxPoolExposurePct: number;
  /** Staged-rollout lifecycle state; only `live` products are public. */
  status: CoverageStatus;
  /** Present once the product has been published; absent while `draft`. */
  approval?: CoverageApprovalRecord;
}

export const COVERAGE_CATALOG = {
  StablecoinDepeg: {
    id: "StablecoinDepeg",
    onChainIndex: 0,
    name: "Stablecoin Depeg",
    description: "Pays out if a major stablecoin depegs below $0.95",
    trigger: "USDC price < $0.95 for 15+ minutes",
    riskLevel: "medium",
    riskMultiplier: 1.0,
    baseRatePct: 3.0,
    maxCoverage: 100_000,
    maxDuration: 30,
    icon: "🪙",
    defaultTriggerThreshold: 500,
    maxPoolExposurePct: 35,
    status: "live",
  },
  MarketCrash: {
    id: "MarketCrash",
    onChainIndex: 1,
    name: "Market Crash",
    description: "Covers catastrophic market downturns exceeding 30% in 24h",
    trigger: "Market index 24h return < -30%",
    riskLevel: "high",
    riskMultiplier: 1.5,
    baseRatePct: 4.5,
    maxCoverage: 50_000,
    maxDuration: 60,
    icon: "📉",
    defaultTriggerThreshold: 3000,
    maxPoolExposurePct: 35,
    status: "live",
  },
  LiquidationShield: {
    id: "LiquidationShield",
    onChainIndex: 2,
    name: "Liquidation Shield",
    description: "Pays out if your DeFi position gets liquidated",
    trigger: "Collateral ratio drops below maintenance threshold",
    riskLevel: "high",
    riskMultiplier: 2.0,
    baseRatePct: 6.0,
    maxCoverage: 200_000,
    maxDuration: 90,
    icon: "🛡️",
    defaultTriggerThreshold: 500,
    maxPoolExposurePct: 35,
    status: "live",
  },
  SmartContractRisk: {
    id: "SmartContractRisk",
    onChainIndex: 3,
    name: "Smart Contract Risk",
    description: "Protection against smart contract exploits and hacks",
    trigger: "Covered protocol TVL drops >50% in <1 hour",
    riskLevel: "critical",
    riskMultiplier: 3.0,
    baseRatePct: 9.0,
    maxCoverage: 500_000,
    maxDuration: 180,
    icon: "🔐",
    defaultTriggerThreshold: 500,
    maxPoolExposurePct: 30,
    status: "live",
  },
  FlightDelay: {
    id: "FlightDelay",
    onChainIndex: 4,
    name: "Flight Delay",
    description: "Automatic payout for flight delays over 2 hours",
    trigger: "Flight delayed > 120 minutes per AviationStack data",
    riskLevel: "low",
    riskMultiplier: 0.8,
    baseRatePct: 2.4,
    maxCoverage: 2_000,
    maxDuration: 7,
    icon: "✈️",
    defaultTriggerThreshold: 120,
    status: "live",
  },
} as const satisfies Record<CoverageType, CoverageProduct>;

/** List form of the catalog, in on-chain index order. */
export const COVERAGE_PRODUCTS: readonly CoverageProduct[] = Object.values(COVERAGE_CATALOG);

/**
 * Public catalog: only `live` products. QuoteService/PolicyService and any
 * other public-facing read must use this so a `draft` coverage type is fully
 * invisible to quote/buy flows.
 */
export const LIVE_COVERAGE_PRODUCTS: readonly CoverageProduct[] = COVERAGE_PRODUCTS.filter(
  (product) => product.status === "live",
);

/**
 * Admin preview catalog: every product regardless of status, so admins can
 * inspect staged drafts before publishing them.
 */
export const ALL_COVERAGE_PRODUCTS: readonly CoverageProduct[] = COVERAGE_PRODUCTS;

/**
 * Looks up a product by its numeric on-chain index. Returns undefined for
 * out-of-range indices so callers can raise their own domain error.
 *
 * By default only `live` products are returned; pass `{ includeDrafts: true }`
 * from admin-only preview paths to also resolve staged drafts.
 */
export function coverageProductByIndex(
  index: number,
  options: { includeDrafts?: boolean } = {},
): CoverageProduct | undefined {
  const source = options.includeDrafts ? ALL_COVERAGE_PRODUCTS : LIVE_COVERAGE_PRODUCTS;
  return source.find((product) => product.onChainIndex === index);
}

/**
 * Records a publish transition for a coverage product, returning a new product
 * object with `status: "live"` and the attached approval record. The original
 * product is not mutated, so callers can persist the returned value.
 */
export function publishCoverageProduct(
  product: CoverageProduct,
  publishedBy: string,
  publishedAt: string = new Date().toISOString(),
): CoverageProduct {
  return {
    ...product,
    status: "live",
    approval: {
      draftedBy: product.approval?.draftedBy ?? "unknown",
      draftedAt: product.approval?.draftedAt ?? publishedAt,
      publishedBy,
      publishedAt,
    },
  };
}

/**
 * Looks up a product by its canonical coverage-type id. Returns undefined for
 * unknown ids so callers can raise their own domain error.
 */
export function coverageProductById(id: CoverageType): CoverageProduct | undefined {
  return COVERAGE_CATALOG[id];
}

/**
 * Computes the maximum aggregate active coverage allowed for a coverage type
 * given the pool's currently locked capital (issue #134).
 *
 * The cap is a percentage of locked capital, so it scales with the pool's
 * size: e.g. a 30% cap on SmartContractRisk permits at most 30% of locked
 * capital to be simultaneously active in that type. Returns 0 when the pool
 * has no locked capital, which correctly blocks any new exposure.
 */
export function maxPoolExposureForType(
  id: CoverageType,
  lockedCapital: number,
): number {
  const product = COVERAGE_CATALOG[id];
  if (!product || lockedCapital <= 0) {
    return 0;
  }
  return (lockedCapital * product.maxPoolExposurePct) / 100;
}

// ---------------------------------------------------------------------------
// Composite / derived feeds (issue #298)
// ---------------------------------------------------------------------------

/**
 * Unit of a feed value. Composites must declare a unit and every formula node
 * must resolve to a defined unit; undefined units are rejected at config load.
 */
export type FeedUnit = "usd" | "ratio" | "bps" | "minutes" | "count";

/** Rounding policy applied to the final composite value. */
export type RoundingMode = "half-up" | "half-even" | "floor" | "ceil" | "truncate";

export interface RoundingPolicy {
  mode: RoundingMode;
  /** Number of decimal places to round to (>= 0). */
  scale: number;
}

/**
 * Trust/quality state of a feed reading. Ordered from best to worst so a
 * composite can inherit the weakest required input state via `max`.
 */
export type FeedQualityState = "ok" | "degraded" | "stale" | "quarantined";

const QUALITY_RANK: Record<FeedQualityState, number> = {
  ok: 0,
  degraded: 1,
  stale: 2,
  quarantined: 3,
};

/** Returns the weaker (worse) of two quality states. */
export function weakestQualityState(
  a: FeedQualityState,
  b: FeedQualityState,
): FeedQualityState {
  return QUALITY_RANK[a] >= QUALITY_RANK[b] ? a : b;
}

/**
 * Non-Turing-complete expression AST. Every node is a plain data object so it
 * can be serialized, versioned, and replayed. There are no loops, no user
 * functions, and no side effects — evaluation is a pure fold over the tree.
 */
export type CompositeExpression =
  | { kind: "input"; feedId: string }
  | { kind: "const"; value: string }
  | { kind: "add"; left: CompositeExpression; right: CompositeExpression }
  | { kind: "sub"; left: CompositeExpression; right: CompositeExpression }
  | { kind: "mul"; left: CompositeExpression; right: CompositeExpression }
  | { kind: "div"; left: CompositeExpression; right: CompositeExpression }
  | { kind: "neg"; operand: CompositeExpression }
  | { kind: "abs"; operand: CompositeExpression }
  | { kind: "min"; operands: CompositeExpression[] }
  | { kind: "max"; operands: CompositeExpression[] };

/** Declared freshness requirement on a single input feed. */
export interface CompositeInputSpec {
  /** Upstream feed id (primitive or another composite). */
  feedId: string;
  /** Maximum age in seconds of the upstream consensus decision. */
  maxAgeSeconds: number;
  /** Unit the upstream feed must be denominated in. */
  unit: FeedUnit;
}

/**
 * Versioned composite feed definition. The `version` is stored with every
 * decision so replay uses the formula version in force at the time.
 */
export interface CompositeFeedDefinition {
  /** Output feed id produced by this composite. */
  outputFeedId: string;
  /** Explicit, monotonically increasing formula version. */
  version: number;
  /** Declared inputs with freshness requirements. */
  inputs: CompositeInputSpec[];
  /** Deterministic expression evaluated over upstream consensus outputs. */
  expression: CompositeExpression;
  /** Unit of the composite's output value. */
  outputUnit: FeedUnit;
  /** Rounding policy applied to the final value. */
  rounding: RoundingPolicy;
}

/** Raised when a composite definition is invalid at config-load time. */
export class CompositeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompositeConfigError";
  }
}

/** Raised when a composite evaluation cannot produce a value. */
export class CompositeEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompositeEvaluationError";
  }
}

/**
 * Upstream consensus output consumed by a composite. Only consensus outputs
 * are ever passed here — never raw single-source readings.
 */
export interface UpstreamConsensusOutput {
  feedId: string;
  /** Consensus decision id, recorded in the composite's evidence. */
  decisionId: string;
  /** Fixed-decimal value of the consensus output. */
  value: FixedDecimal;
  unit: FeedUnit;
  /** Quality state of the upstream consensus decision. */
  quality: FeedQualityState;
  /** Unix timestamp (seconds) at which the upstream decision was produced. */
  decidedAt: number;
}

/** Evidence record emitted for every composite evaluation. */
export interface CompositeEvidenceRecord {
  outputFeedId: string;
  formulaVersion: number;
  /** Ordered input decision ids (in declared input order). */
  inputDecisionIds: string[];
  /** Computed value serialized as a canonical fixed-decimal string. */
  computedValue: string;
  unit: FeedUnit;
  quality: FeedQualityState;
  evaluatedAt: number;
}

/** Consensus-quality decision emitted for every composite evaluation. */
export interface CompositeDecision {
  outputFeedId: string;
  formulaVersion: number;
  value: FixedDecimal;
  unit: FeedUnit;
  quality: FeedQualityState;
  evidence: CompositeEvidenceRecord;
}

// --- Config-load validation -------------------------------------------------

function collectInputFeedIds(expr: CompositeExpression, acc: Set<string>): void {
  switch (expr.kind) {
    case "input":
      acc.add(expr.feedId);
      return;
    case "const":
      return;
    case "neg":
    case "abs":
      collectInputFeedIds(expr.operand, acc);
      return;
    case "min":
    case "max":
      for (const operand of expr.operands) {
        collectInputFeedIds(operand, acc);
      }
      return;
    case "add":
    case "sub":
    case "mul":
    case "div":
      collectInputFeedIds(expr.left, acc);
      collectInputFeedIds(expr.right, acc);
      return;
    default: {
      const _exhaustive: never = expr;
      throw new CompositeConfigError(`unknown expression node: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Validates a single composite definition in isolation: rejects self-reference,
 * undefined units, malformed rounding, and expressions referencing feeds not
 * declared as inputs. Cross-composite cycle detection is done by
 * `buildCompositeDependencyGraph`.
 */
export function validateCompositeDefinition(def: CompositeFeedDefinition): void {
  if (!def.outputFeedId) {
    throw new CompositeConfigError("composite feed requires an outputFeedId");
  }
  if (!Number.isInteger(def.version) || def.version < 1) {
    throw new CompositeConfigError(
      `composite ${def.outputFeedId}: version must be a positive integer`,
    );
  }
  if (!def.outputUnit) {
    throw new CompositeConfigError(`composite ${def.outputFeedId}: outputUnit is required`);
  }
  if (!def.rounding || !Number.isInteger(def.rounding.scale) || def.rounding.scale < 0) {
    throw new CompositeConfigError(
      `composite ${def.outputFeedId}: rounding.scale must be a non-negative integer`,
    );
  }
  if (!["half-up", "half-even", "floor", "ceil", "truncate"].includes(def.rounding.mode)) {
    throw new CompositeConfigError(
      `composite ${def.outputFeedId}: unknown rounding mode ${def.rounding.mode}`,
    );
  }
  if (def.inputs.length === 0) {
    throw new CompositeConfigError(`composite ${def.outputFeedId}: at least one input required`);
  }

  const declared = new Set<string>();
  for (const input of def.inputs) {
    if (!input.feedId) {
      throw new CompositeConfigError(`composite ${def.outputFeedId}: input feedId is required`);
    }
    if (input.feedId === def.outputFeedId) {
      throw new CompositeConfigError(
        `composite ${def.outputFeedId}: self-reference is not allowed`,
      );
    }
    if (!input.unit) {
      throw new CompositeConfigError(
        `composite ${def.outputFeedId}: input ${input.feedId} has undefined unit`,
      );
    }
    if (!Number.isFinite(input.maxAgeSeconds) || input.maxAgeSeconds <= 0) {
      throw new CompositeConfigError(
        `composite ${def.outputFeedId}: input ${input.feedId} requires a positive maxAgeSeconds`,
      );
    }
    if (declared.has(input.feedId)) {
      throw new CompositeConfigError(
        `composite ${def.outputFeedId}: duplicate input ${input.feedId}`,
      );
    }
    declared.add(input.feedId);
  }

  const referenced = new Set<string>();
  collectInputFeedIds(def.expression, referenced);
  for (const feedId of referenced) {
    if (!declared.has(feedId)) {
      throw new CompositeConfigError(
        `composite ${def.outputFeedId}: expression references undeclared input ${feedId}`,
      );
    }
  }
}

// --- Dependency graph & topological ordering --------------------------------

export interface CompositeDependencyGraph {
  /** outputFeedId -> set of upstream feed ids it depends on. */
  edges: Map<string, Set<string>>;
  /** Topologically ordered output feed ids (upstreams before dependents). */
  order: string[];
}

/**
 * Builds a dependency graph across composite definitions and returns a
 * topological evaluation order. Rejects cycles (including self-reference) and
 * duplicate output feed ids. Primitive upstream feeds are treated as leaves.
 */
export function buildCompositeDependencyGraph(
  definitions: readonly CompositeFeedDefinition[],
): CompositeDependencyGraph {
  const byOutput = new Map<string, CompositeFeedDefinition>();
  for (const def of definitions) {
    validateCompositeDefinition(def);
    if (byOutput.has(def.outputFeedId)) {
      throw new CompositeConfigError(`duplicate composite output feed ${def.outputFeedId}`);
    }
    byOutput.set(def.outputFeedId, def);
  }

  const edges = new Map<string, Set<string>>();
  for (const def of definitions) {
    edges.set(def.outputFeedId, new Set(def.inputs.map((i) => i.feedId)));
  }

  // Kahn's algorithm over composite nodes only; primitive inputs are leaves.
  const inDegree = new Map<string, number>();
  for (const id of byOutput.keys()) {
    inDegree.set(id, 0);
  }
  for (const [id, deps] of edges) {
    for (const dep of deps) {
      if (byOutput.has(dep)) {
        inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }
  queue.sort();

  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const [dependent, deps] of edges) {
      if (deps.has(id)) {
        const next = (inDegree.get(dependent) ?? 0) - 1;
        inDegree.set(dependent, next);
        if (next === 0) {
          queue.push(dependent);
          queue.sort();
        }
      }
    }
  }

  if (order.length !== byOutput.size) {
    const cyclic = [...byOutput.keys()].filter((id) => !order.includes(id));
    throw new CompositeConfigError(
      `composite dependency cycle detected among: ${cyclic.sort().join(", ")}`,
    );
  }

  return { edges, order };
}

// --- Pure fixed-decimal AST evaluator ---------------------------------------

function roundFixed(value: FixedDecimal, policy: RoundingPolicy): FixedDecimal {
  return value.round(policy.scale, policy.mode);
}

function evalNode(
  expr: CompositeExpression,
  values: Map<string, FixedDecimal>,
): FixedDecimal {
  switch (expr.kind) {
    case "input": {
      const v = values.get(expr.feedId);
      if (v === undefined) {
        throw new CompositeEvaluationError(`missing value for input ${expr.feedId}`);
      }
      return v;
    }
    case "const":
      return FixedDecimal.parse(expr.value);
    case "add":
      return evalNode(expr.left, values).add(evalNode(expr.right, values));
    case "sub":
      return evalNode(expr.left, values).sub(evalNode(expr.right, values));
    case "mul":
      return evalNode(expr.left, values).mul(evalNode(expr.right, values));
    case "div": {
      const divisor = evalNode(expr.right, values);
      if (divisor.isZero()) {
        throw new CompositeEvaluationError("division by zero");
      }
      return evalNode(expr.left, values).div(divisor);
    }
    case "neg":
      return evalNode(expr.operand, values).neg();
    case "abs":
      return evalNode(expr.operand, values).abs();
    case "min": {
      if (expr.operands.length === 0) {
        throw new CompositeEvaluationError("min requires at least one operand");
      }
      let acc = evalNode(expr.operands[0], values);
      for (let i = 1; i < expr.operands.length; i += 1) {
        acc = acc.min(evalNode(expr.operands[i], values));
      }
      return acc;
    }
    case "max": {
      if (expr.operands.length === 0) {
        throw new CompositeEvaluationError("max requires at least one operand");
      }
      let acc = evalNode(expr.operands[0], values);
      for (let i = 1; i < expr.operands.length; i += 1) {
        acc = acc.max(evalNode(expr.operands[i], values));
      }
      return acc;
    }
    default: {
      const _exhaustive: never = expr;
      throw new CompositeEvaluationError(
        `unknown expression node: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

/**
 * Evaluates a composite definition over upstream consensus outputs. Pure and
 * deterministic: identical inputs and formula version always produce the
 * identical output byte-for-byte.
 *
 * Only consensus outputs are accepted. Each declared input must be present,
 * match the declared unit, and be within its freshness window; otherwise the
 * composite inherits the weakest required input state (stale/quarantined/
 * degraded). Divide-by-zero, overflow, and NaN are rejected.
 */
export function evaluateComposite(
  def: CompositeFeedDefinition,
  upstream: readonly UpstreamConsensusOutput[],
  evaluatedAt: number,
): CompositeDecision {
  validateCompositeDefinition(def);

  const byFeed = new Map<string, UpstreamConsensusOutput>();
  for (const output of upstream) {
    byFeed.set(output.feedId, output);
  }

  let quality: FeedQualityState = "ok";
  const values = new Map<string, FixedDecimal>();
  const inputDecisionIds: string[] = [];

  for (const input of def.inputs) {
    const output = byFeed.get(input.feedId);
    if (!output) {
      throw new CompositeEvaluationError(
        `composite ${def.outputFeedId}: missing upstream consensus output for ${input.feedId}`,
      );
    }
    if (output.unit !== input.unit) {
      throw new CompositeEvaluationError(
        `composite ${def.outputFeedId}: unit mismatch for ${input.feedId} ` +
          `(expected ${input.unit}, got ${output.unit})`,
      );
    }
    const age = evaluatedAt - output.decidedAt;
    let inputQuality = output.quality;
    if (age > input.maxAgeSeconds && inputQuality === "ok") {
      inputQuality = "stale";
    }
    quality = weakestQualityState(quality, inputQuality);
    values.set(input.feedId, output.value);
    inputDecisionIds.push(output.decisionId);
  }

  let computed: FixedDecimal;
  try {
    computed = roundFixed(evalNode(def.expression, values), def.rounding);
  } catch (err) {
    if (err instanceof FixedDecimalError) {
      throw new CompositeEvaluationError(
        `composite ${def.outputFeedId}: ${err.message}`,
      );
    }
    throw err;
  }

  const computedValue = computed.toString();
  const evidence: CompositeEvidenceRecord = {
    outputFeedId: def.outputFeedId,
    formulaVersion: def.version,
    inputDecisionIds,
    computedValue,
    unit: def.outputUnit,
    quality,
    evaluatedAt,
  };

  return {
    outputFeedId: def.outputFeedId,
    formulaVersion: def.version,
    value: computed,
    unit: def.outputUnit,
    quality,
    evidence,
  };
}

/**
 * Evaluates a batch of composite definitions in topological order, threading
 * each composite's output back in as an upstream consensus output for
 * dependents. Returns decisions keyed by output feed id.
 */
export function evaluateCompositeBatch(
  definitions: readonly CompositeFeedDefinition[],
  primitiveUpstream: readonly UpstreamConsensusOutput[],
  evaluatedAt: number,
): Map<string, CompositeDecision> {
  const graph = buildCompositeDependencyGraph(definitions);
  const byOutput = new Map<string, CompositeFeedDefinition>();
  for (const def of definitions) {
    byOutput.set(def.outputFeedId, def);
  }

  const available = new Map<string, UpstreamConsensusOutput>();
  for (const output of primitiveUpstream) {
    available.set(output.feedId, output);
  }

  const decisions = new Map<string, CompositeDecision>();
  for (const outputFeedId of graph.order) {
    const def = byOutput.get(outputFeedId) as CompositeFeedDefinition;
    const decision = evaluateComposite(def, [...available.values()], evaluatedAt);
    decisions.set(outputFeedId, decision);
    available.set(outputFeedId, {
      feedId: outputFeedId,
      decisionId: `composite:${outputFeedId}:v${decision.formulaVersion}:${decision.evidence.computedValue}`,
      value: decision.value,
      unit: decision.unit,
      quality: decision.quality,
      decidedAt: evaluatedAt,
    });
  }
  return decisions;
}