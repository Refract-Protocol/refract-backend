import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUILT_IN_ORACLE_CONFIG,
  OracleConfigFile,
  OracleConfigParseError,
  loadOracleConfig,
  parseOracleConfig,
} from "./oracle-feed-config";
import { independentSourceCount, validateOracleConfig } from "./oracle-config.validator";
import { OracleConfigInvalidError, assertOracleConfigAtStartup } from "./oracle-config.startup";
import { runOracleConfigLint } from "./oracle-config-lint.cli";
import { resolveFeeds } from "./oracle-feed-config";

type FeedOverrides = Partial<OracleConfigFile["feeds"][number]>;

function config(feed: FeedOverrides = {}, defaults: OracleConfigFile["defaults"] = { trustMode: "median_quorum" }): OracleConfigFile {
  return {
    version: 1,
    defaults,
    feeds: [
      {
        id: "depeg",
        coverageType: "StablecoinDepeg",
        quorum: { minSources: 2 },
        sources: [
          { id: "a", adapter: "coingecko", operator: "coingecko" },
          { id: "b", adapter: "horizon", operator: "stellar-dex" },
          { id: "c", adapter: "defillama", operator: "defillama" },
        ],
        ...feed,
      },
    ],
  };
}

const codes = (cfg: OracleConfigFile, network = "testnet") => {
  const report = validateOracleConfig(cfg, { network });
  return { errors: report.errors.map((i) => i.code), warnings: report.warnings.map((i) => i.code) };
};

const EXAMPLE_PATH = join(__dirname, "../../../docs/oracle-feeds.example.json");

describe("validateOracleConfig", () => {
  it("accepts a well-formed quorum feed", () => {
    expect(codes(config())).toEqual({ errors: [], warnings: [] });
  });

  it("rejects a quorum larger than the number of independent sources", () => {
    const result = codes(config({ quorum: { minSources: 4 } }));
    expect(result.errors).toContain("QUORUM_EXCEEDS_INDEPENDENT_SOURCES");
  });

  it("counts sources with the same operator as one independent source", () => {
    const cfg = config({
      quorum: { minSources: 2 },
      sources: [
        { id: "a", adapter: "coingecko", params: { coinId: "usd-coin" } },
        { id: "b", adapter: "coingecko", params: { coinId: "usd-coin" } },
        { id: "c", adapter: "horizon", operator: "coingecko" },
      ],
    });
    expect(independentSourceCount(resolveFeeds(cfg)[0])).toBe(1);
    const result = codes(cfg);
    expect(result.errors).toContain("QUORUM_EXCEEDS_INDEPENDENT_SOURCES");
    expect(result.warnings).toContain("SHARED_OPERATOR");
  });

  it("ignores disabled sources when counting toward quorum", () => {
    const cfg = config({
      sources: [
        { id: "a", adapter: "coingecko" },
        { id: "b", adapter: "horizon", enabled: false },
      ],
    });
    expect(codes(cfg).errors).toContain("QUORUM_EXCEEDS_INDEPENDENT_SOURCES");
  });

  it("rejects a freshness window shorter than the poll interval", () => {
    const result = codes(config({ pollIntervalMs: 60_000, freshnessWindowMs: 30_000 }));
    expect(result.errors).toContain("FRESHNESS_SHORTER_THAN_POLL");
  });

  it("warns when the freshness window allows no missed poll", () => {
    const result = codes(config({ pollIntervalMs: 60_000, freshnessWindowMs: 90_000 }));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toContain("FRESHNESS_WINDOW_TIGHT");
  });

  it("rejects a feed with no trust mode on the feed or in defaults", () => {
    const result = codes(config({}, {}));
    expect(result.errors).toContain("MISSING_TRUST_MODE");
  });

  it("rejects an unknown trust mode", () => {
    expect(codes(config({ trustMode: "vibes" })).errors).toContain("UNKNOWN_TRUST_MODE");
  });

  it("rejects quorum modes with a quorum of one", () => {
    expect(codes(config({ quorum: { minSources: 1 } })).errors).toContain("QUORUM_MODE_WITHOUT_QUORUM");
  });

  it("rejects single_source with a multi-source quorum", () => {
    const result = codes(config({ trustMode: "single_source", quorum: { minSources: 2 } }));
    expect(result.errors).toContain("TRUST_MODE_QUORUM_CONFLICT");
  });

  it("rejects single-source and mock feeds that settle claims on mainnet only", () => {
    const cfg = config({
      trustMode: "single_source",
      quorum: { minSources: 1 },
      sources: [{ id: "m", adapter: "mock" }],
    });
    expect(codes(cfg, "testnet").errors).toEqual([]);
    expect(codes(cfg, "testnet").warnings).toContain("SINGLE_SOURCE");
    expect(codes(cfg, "mainnet").errors).toEqual(
      expect.arrayContaining(["SINGLE_SOURCE_ON_MAINNET", "MOCK_SOURCE_ON_MAINNET"])
    );
    expect(codes({ ...cfg, feeds: [{ ...cfg.feeds[0], settlesClaims: false }] }, "mainnet").errors).toEqual([]);
  });

  it("warns on a minority quorum and on zero quorum headroom", () => {
    const five = config({
      quorum: { minSources: 2 },
      sources: ["a", "b", "c", "d", "e"].map((id) => ({ id, adapter: "coingecko", operator: id })),
    });
    expect(codes(five).warnings).toContain("MINORITY_QUORUM");
    expect(codes(config({ quorum: { minSources: 3 } })).warnings).toContain("NO_QUORUM_HEADROOM");
  });

  it("requires weights for weighted_quorum and rejects an operator holding the majority of weight", () => {
    expect(codes(config({ trustMode: "weighted_quorum" })).errors).toContain("MISSING_SOURCE_WEIGHT");

    const skewed = config({
      trustMode: "weighted_quorum",
      sources: [
        { id: "a", adapter: "coingecko", operator: "x", weight: 6 },
        { id: "b", adapter: "horizon", operator: "y", weight: 2 },
        { id: "c", adapter: "defillama", operator: "z", weight: 2 },
      ],
    });
    expect(codes(skewed).errors).toContain("OPERATOR_CONTROLS_QUORUM");
  });

  it("rejects duplicate ids, unknown adapters and coverage types, and bad numeric ranges", () => {
    const cfg = config({
      coverageType: "Earthquake",
      pollIntervalMs: 10,
      freshnessWindowMs: 1_000,
      quorum: { minSources: 2, maxDeviationBps: 0 },
      sources: [
        { id: "a", adapter: "coingecko", operator: "1" },
        { id: "a", adapter: "chainlink", operator: "2" },
      ],
    });
    cfg.feeds.push({ ...cfg.feeds[0] });
    const { errors } = codes(cfg);
    expect(errors).toEqual(
      expect.arrayContaining([
        "DUPLICATE_FEED_ID",
        "DUPLICATE_SOURCE_ID",
        "UNKNOWN_ADAPTER",
        "UNKNOWN_COVERAGE_TYPE",
        "POLL_INTERVAL_TOO_SHORT",
        "DEVIATION_OUT_OF_RANGE",
      ])
    );
  });

  it("rejects an empty config and a feed with no enabled sources", () => {
    expect(codes({ version: 1, feeds: [] }).errors).toEqual(["NO_FEEDS"]);
    expect(codes(config({ sources: [{ id: "a", adapter: "coingecko", enabled: false }] })).errors).toContain(
      "NO_ENABLED_SOURCES"
    );
  });

  it("warns when the publish interval lets the on-chain reading outlive the freshness window", () => {
    const result = codes(config({ publish: { minIntervalMs: 600_000 }, freshnessWindowMs: 300_000 }));
    expect(result.warnings).toContain("PUBLISH_INTERVAL_EXCEEDS_FRESHNESS");
  });

  it("accepts the built-in feeds off mainnet but rejects them on mainnet", () => {
    expect(validateOracleConfig(BUILT_IN_ORACLE_CONFIG, { network: "testnet" }).errors).toEqual([]);
    expect(validateOracleConfig(BUILT_IN_ORACLE_CONFIG, { network: "mainnet" }).errors.length).toBeGreaterThan(0);
  });

  it("accepts the documented example config", () => {
    const example = parseOracleConfig(JSON.parse(readFileSync(EXAMPLE_PATH, "utf8")), "example");
    expect(validateOracleConfig(example, { network: "testnet" }).errors).toEqual([]);
    expect(validateOracleConfig(example, { network: "mainnet" }).errors.map((e) => e.feed)).toEqual([
      "smart-contract-risk",
    ]);
  });
});

describe("loadOracleConfig", () => {
  it("falls back to the built-in feeds", () => {
    expect(loadOracleConfig({}).origin).toBe("built-in defaults");
  });

  it("loads inline JSON and files, and reports structural problems with their path", () => {
    expect(loadOracleConfig({ ORACLE_FEEDS_JSON: JSON.stringify(config()) }).config.feeds).toHaveLength(1);
    expect(loadOracleConfig({ ORACLE_FEEDS_FILE: "/x.json" }, () => JSON.stringify(config())).origin).toBe(
      "file /x.json"
    );
    expect(() => loadOracleConfig({ ORACLE_FEEDS_JSON: '{"version":1,"feeds":[{"id":"x"}]}' })).toThrow(
      /feeds\.0\.coverageType/
    );
    expect(() => loadOracleConfig({ ORACLE_FEEDS_JSON: "{nope" })).toThrow(OracleConfigParseError);
    expect(() => loadOracleConfig({ ORACLE_FEEDS_JSON: "{}", ORACLE_FEEDS_FILE: "/x" })).toThrow(/only one/);
  });

  it("rejects unknown keys so typos do not silently fall back to defaults", () => {
    const typo = { ...config(), feeds: [{ ...config().feeds[0], freshnesWindowMs: 1 }] };
    expect(() => loadOracleConfig({ ORACLE_FEEDS_JSON: JSON.stringify(typo) })).toThrow(/freshnesWindowMs/);
  });
});

describe("assertOracleConfigAtStartup", () => {
  it("returns the validated config and logs the summary", () => {
    const logger = { log: jest.fn(), warn: jest.fn() };
    const result = assertOracleConfigAtStartup({ ORACLE_FEEDS_JSON: JSON.stringify(config()) }, logger);
    expect(result.report.errors).toEqual([]);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("1 feed(s), 0 error(s)"));
  });

  it("throws before startup on errors", () => {
    const bad = JSON.stringify(config({ quorum: { minSources: 9 } }));
    expect(() => assertOracleConfigAtStartup({ ORACLE_FEEDS_JSON: bad })).toThrow(OracleConfigInvalidError);
    expect(() => assertOracleConfigAtStartup({ ORACLE_FEEDS_JSON: bad })).toThrow(
      /QUORUM_EXCEEDS_INDEPENDENT_SOURCES/
    );
  });

  it("throws on malformed config", () => {
    expect(() => assertOracleConfigAtStartup({ ORACLE_FEEDS_JSON: "[]" })).toThrow(OracleConfigInvalidError);
  });

  it("treats warnings as fatal only in strict mode", () => {
    const warn = JSON.stringify(config({ quorum: { minSources: 3 } }));
    const logger = { log: jest.fn(), warn: jest.fn() };
    expect(() => assertOracleConfigAtStartup({ ORACLE_FEEDS_JSON: warn }, logger)).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("NO_QUORUM_HEADROOM"));
    expect(() =>
      assertOracleConfigAtStartup({ ORACLE_FEEDS_JSON: warn, ORACLE_CONFIG_STRICT: "true" })
    ).toThrow(/ORACLE_CONFIG_STRICT/);
  });

  it("refuses the built-in single-source feeds on mainnet", () => {
    expect(() => assertOracleConfigAtStartup({ STELLAR_NETWORK: "mainnet" })).toThrow(/SINGLE_SOURCE_ON_MAINNET/);
  });
});

describe("oracle-config-lint CLI", () => {
  const run = (argv: string[], env: NodeJS.ProcessEnv = {}, files: Record<string, string> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = runOracleConfigLint(
      argv,
      { out: (l) => out.push(l), err: (l) => err.push(l) },
      env,
      (path) => {
        if (!(path in files)) throw new Error(`ENOENT: ${path}`);
        return files[path];
      }
    );
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  it("exits 0 for a valid file and 1 for an invalid one", () => {
    const files = {
      "/ok.json": JSON.stringify(config()),
      "/bad.json": JSON.stringify(config({ freshnessWindowMs: 1_000 })),
    };
    expect(run(["--file", "/ok.json"], {}, files)).toMatchObject({ code: 0 });
    const bad = run(["--file", "/bad.json"], {}, files);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/FRESHNESS_SHORTER_THAN_POLL/);
  });

  it("checks against the requested network and honours --strict", () => {
    expect(run(["--network", "mainnet"]).code).toBe(1);
    expect(run([]).code).toBe(0);
    expect(run(["--strict"]).code).toBe(1);
  });

  it("exits 2 for usage errors and unreadable files", () => {
    expect(run(["--bogus"]).code).toBe(2);
    expect(run(["--file", "/missing.json"]).code).toBe(2);
  });

  it("prints a machine-readable report with --json", () => {
    const { code, out } = run(["--json", "--network", "mainnet"]);
    const parsed = JSON.parse(out);
    expect(code).toBe(1);
    expect(parsed).toMatchObject({ valid: false, network: "mainnet", origin: "built-in defaults" });
    expect(parsed.errors.length).toBeGreaterThan(0);
  });
});
